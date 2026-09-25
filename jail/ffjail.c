/* ffjail: runs ffmpeg as its own user in an empty chroot, one decode per connection.
   `serve` is started as root by the entrypoint; `run` is what the worker spawns. */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error "the seccomp filter is written for x86_64 and aarch64 only"
#endif

#ifndef SYS_clone3
#define SYS_clone3 435
#endif

#define MAX_REQUEST 16384
#define MAX_ARGS 64
#define NFDS 4 /* stdin, stdout, stderr, and the input file as fd 3 */
#define JAIL_FAILED 125 /* ffmpeg never ran */

struct header {
    uint64_t memory_bytes;
    uint32_t timeout_ms;
    uint32_t argc;
};

static void die(const char *what) {
    fprintf(stderr, "ffjail: %s: %s\n", what, strerror(errno));
    exit(JAIL_FAILED);
}

static int parse_u64(const char *s, uint64_t *out) {
    char *end;
    if (s[0] < '0' || s[0] > '9') return -1;
    errno = 0;
    unsigned long long v = strtoull(s, &end, 10);
    if (errno || *end) return -1;
    *out = v;
    return 0;
}

static struct sockaddr_un socket_address(const char *path) {
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    if (strlen(path) >= sizeof addr.sun_path) {
        fprintf(stderr, "ffjail: socket path too long\n");
        exit(JAIL_FAILED);
    }
    strcpy(addr.sun_path, path);
    return addr;
}

#define DENY(nr, err) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
                      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err))

/* No sockets, no reaching into another process, and threads but no new processes.
   clone3 answers ENOSYS so libc falls back to clone, whose flags a filter can read. */
static int lock_down(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __x86_64__
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1), /* the x32 ABI */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY(SYS_fork, EPERM),
        DENY(SYS_vfork, EPERM),
#endif
        DENY(SYS_socket, EPERM),
        DENY(SYS_socketpair, EPERM),
        DENY(SYS_ptrace, EPERM),
        DENY(SYS_process_vm_readv, EPERM),
        DENY(SYS_process_vm_writev, EPERM),
        DENY(SYS_clone3, ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog prog = {.len = sizeof filter / sizeof filter[0], .filter = filter};
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
}

/* Once fd 2 is the worker's stderr, this is what the worker logs as the reason. */
static void give_up(const char *what) {
    dprintf(2, "ffjail: %s: %s\n", what, strerror(errno));
    _exit(JAIL_FAILED);
}

static void set_limit(int resource, rlim_t value) {
    struct rlimit rl = {value, value};
    if (setrlimit(resource, &rl) != 0) give_up("setrlimit");
}

static void exec_decoder(int decoder, const int fds[NFDS], const struct header *h, char **argv) {
    int high[NFDS];
    for (int i = 0; i < NFDS; i++)
        if ((high[i] = fcntl(fds[i], F_DUPFD_CLOEXEC, 16)) < 0) give_up("dup");
    for (int i = 0; i < NFDS; i++)
        if (dup2(high[i], i) != i) give_up("dup2");
    for (int fd = NFDS; fd < 1024; fd++)
        if (fd != decoder) close(fd);

    set_limit(RLIMIT_AS, h->memory_bytes);
    set_limit(RLIMIT_CPU, h->timeout_ms / 1000 + 5);
    set_limit(RLIMIT_FSIZE, 0);
    set_limit(RLIMIT_NOFILE, 64);
    set_limit(RLIMIT_CORE, 0);
    if (lock_down() != 0) give_up("seccomp");

    char *envp[] = {NULL};
    syscall(SYS_execveat, decoder, "", argv, envp, AT_EMPTY_PATH);
    give_up("exec");
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* One per connection. Kills the decoder when the worker hangs up or time runs out,
   then answers with its wait status. */
static void watch(int conn, int decoder) {
    static char buf[MAX_REQUEST];
    union {
        char bytes[CMSG_SPACE(sizeof(int) * NFDS)];
        struct cmsghdr align;
    } control;
    struct iovec iov = {buf, sizeof buf};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes};

    ssize_t n = recvmsg(conn, &msg, MSG_CMSG_CLOEXEC);
    struct cmsghdr *c = n > 0 ? CMSG_FIRSTHDR(&msg) : NULL;
    if (n < (ssize_t)sizeof(struct header) || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) || !c ||
        c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(sizeof(int) * NFDS))
        _exit(1);

    int fds[NFDS];
    memcpy(fds, CMSG_DATA(c), sizeof fds);
    struct header h;
    memcpy(&h, buf, sizeof h);
    if (h.argc == 0 || h.argc > MAX_ARGS || h.memory_bytes == 0 || h.timeout_ms == 0) _exit(1);

    char *argv[MAX_ARGS + 2] = {"ffmpeg"};
    size_t off = sizeof h;
    for (uint32_t i = 0; i < h.argc; i++) {
        char *end = off < (size_t)n ? memchr(buf + off, '\0', (size_t)n - off) : NULL;
        if (!end) _exit(1);
        argv[i + 1] = buf + off;
        off = (size_t)(end - buf) + 1;
    }
    if (off != (size_t)n) _exit(1);

    pid_t pid = fork();
    if (pid < 0) _exit(1);
    if (pid == 0) exec_decoder(decoder, fds, &h, argv);
    for (int i = 0; i < NFDS; i++) close(fds[i]);

    long long deadline = now_ms() + h.timeout_ms;
    int status;
    for (;;) {
        if (waitpid(pid, &status, WNOHANG) == pid) break;
        struct pollfd p = {conn, POLLIN, 0};
        if (poll(&p, 1, 20) > 0 || now_ms() > deadline) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            break;
        }
    }
    int32_t out = status;
    send(conn, &out, sizeof out, MSG_NOSIGNAL);
    _exit(0);
}

static int serve(char **args) {
    const char *path = args[0], *jail = args[1], *decoder_path = args[2];
    uint64_t uid, gid, client_gid;
    if (parse_u64(args[3], &uid) || parse_u64(args[4], &gid) || parse_u64(args[5], &client_gid) || uid == 0 || gid == 0) {
        fprintf(stderr, "ffjail: bad uid or gid\n");
        return 2;
    }

    /* Held above fd 3, which the decoder's input takes. */
    int opened = open(decoder_path, O_PATH | O_CLOEXEC);
    if (opened < 0) die(decoder_path);
    int decoder = fcntl(opened, F_DUPFD_CLOEXEC, 100);
    if (decoder < 0) die("dup");
    close(opened);

    struct sockaddr_un addr = socket_address(path);
    int lsock = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (lsock < 0) die("socket");
    unlink(path);
    mode_t old = umask(0177);
    if (bind(lsock, (struct sockaddr *)&addr, sizeof addr) != 0) die("bind");
    umask(old);
    if (chown(path, 0, (gid_t)client_gid) != 0 || chmod(path, 0660) != 0) die("chown socket");
    if (listen(lsock, 16) != 0) die("listen");

    if (chroot(jail) != 0 || chdir("/") != 0) die("chroot");
    if (setgroups(0, NULL) != 0 || setresgid((gid_t)gid, (gid_t)gid, (gid_t)gid) != 0 ||
        setresuid((uid_t)uid, (uid_t)uid, (uid_t)uid) != 0)
        die("drop to the jail user");
    if (setuid(0) == 0) {
        fprintf(stderr, "ffjail: got root back after dropping it\n");
        return 2;
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) die("prctl");

    /* The parent returns once the socket listens, so the entrypoint knows it's up. */
    pid_t pid = fork();
    if (pid < 0) die("fork");
    if (pid > 0) return 0;
    setsid();
    signal(SIGCHLD, SIG_IGN);

    for (;;) {
        int conn = accept4(lsock, NULL, NULL, SOCK_CLOEXEC);
        if (conn < 0) {
            if (errno == EINTR || errno == ECONNABORTED) continue;
            die("accept");
        }
        if (fork() == 0) {
            close(lsock);
            signal(SIGCHLD, SIG_DFL);
            watch(conn, decoder);
        }
        close(conn);
    }
}

static int run(int argc, char **argv) {
    uint64_t memory_bytes, timeout_ms;
    if (argc < 5 || strcmp(argv[3], "--") != 0 || parse_u64(argv[1], &memory_bytes) ||
        parse_u64(argv[2], &timeout_ms) || timeout_ms > UINT32_MAX || argc - 4 > MAX_ARGS) {
        fprintf(stderr, "usage: ffjail run SOCKET MEMORY_BYTES TIMEOUT_MS -- FFMPEG_ARGS...\n");
        return 2;
    }
    if (fcntl(3, F_GETFD) < 0) {
        fprintf(stderr, "ffjail: the input has to be open as fd 3\n");
        return 2;
    }

    static char buf[MAX_REQUEST];
    struct header h = {memory_bytes, (uint32_t)timeout_ms, (uint32_t)(argc - 4)};
    size_t len = sizeof h;
    memcpy(buf, &h, sizeof h);
    for (int i = 4; i < argc; i++) {
        size_t l = strlen(argv[i]) + 1;
        if (len + l > sizeof buf) {
            fprintf(stderr, "ffjail: arguments too long\n");
            return 2;
        }
        memcpy(buf + len, argv[i], l);
        len += l;
    }

    struct sockaddr_un addr = socket_address(argv[0]);
    int s = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (s < 0) die("socket");
    if (connect(s, (struct sockaddr *)&addr, sizeof addr) != 0) die("cannot reach the jail");

    int fds[NFDS] = {0, 1, 2, 3};
    union {
        char bytes[CMSG_SPACE(sizeof fds)];
        struct cmsghdr align;
    } control;
    memset(&control, 0, sizeof control);
    struct iovec iov = {buf, len};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes};
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof fds);
    memcpy(CMSG_DATA(c), fds, sizeof fds);
    if (sendmsg(s, &msg, MSG_NOSIGNAL) != (ssize_t)len) die("send");
    close(3);

    int32_t status;
    if (recv(s, &status, sizeof status, MSG_WAITALL) != sizeof status) {
        fprintf(stderr, "ffjail: the jail hung up without a result\n");
        return JAIL_FAILED;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) {
        signal(WTERMSIG(status), SIG_DFL);
        raise(WTERMSIG(status));
    }
    return JAIL_FAILED;
}

int main(int argc, char **argv) {
    if (argc == 8 && strcmp(argv[1], "serve") == 0) return serve(argv + 2);
    if (argc >= 2 && strcmp(argv[1], "run") == 0) return run(argc - 2, argv + 2);
    fprintf(stderr,
            "usage: ffjail serve SOCKET JAIL DECODER UID GID CLIENT_GID\n"
            "       ffjail run SOCKET MEMORY_BYTES TIMEOUT_MS -- FFMPEG_ARGS...\n");
    return 2;
}
