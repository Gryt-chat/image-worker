/* Stands in for a compromised ffmpeg: started the way ffmpeg is, it tries what an
   exploit would and prints one `name yes|no detail` line per attempt. */

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void line(const char *name, int yes, const char *detail) {
    printf("%s %s %s\n", name, yes ? "yes" : "no", detail);
}

static void attempt(const char *name, int rc) {
    line(name, rc >= 0, rc >= 0 ? "-" : strerror(errno));
}

static void read_file(const char *name, const char *path, const char *canary) {
    char buf[65536];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return attempt(name, -1);
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n < 0) return attempt(name, -1);
    buf[n] = 0;
    for (ssize_t i = 0; i < n; i++)
        if (!buf[i]) buf[i] = '\n';
    line(name, 1, canary && strstr(buf, canary) ? "canary" : "-");
}

static void list_dir(const char *name, const char *path) {
    DIR *d = opendir(path);
    if (!d) return attempt(name, -1);
    int count = 0;
    struct dirent *e;
    while ((e = readdir(d)))
        if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) count++;
    closedir(d);
    char detail[32];
    snprintf(detail, sizeof detail, "%d-entries", count);
    line(name, count > 0, detail);
}

int main(void) {
    const char *canary = "gryt-ff-canary";
    char detail[64];

    snprintf(detail, sizeof detail, "%d", getuid());
    line("uid", 1, detail);
    snprintf(detail, sizeof detail, "%d", getgroups(0, NULL));
    line("groups", 1, detail);
    int envc = 0;
    while (environ && environ[envc]) envc++;
    snprintf(detail, sizeof detail, "%d", envc);
    line("own_env", envc > 0, detail);
    snprintf(detail, sizeof detail, "%d", prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
    line("no_new_privs", 1, detail);
    struct __user_cap_header_struct ch = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct cd[2] = {0};
    syscall(SYS_capget, &ch, cd);
    line("capabilities", cd[0].effective || cd[1].effective || cd[0].permitted || cd[1].permitted, "-");
    struct rlimit rl;
    getrlimit(RLIMIT_AS, &rl);
    snprintf(detail, sizeof detail, "%llu", (unsigned long long)rl.rlim_cur);
    line("rlimit_as", 1, detail);

    read_file("read_worker_environ", "/proc/1/environ", canary);
    read_file("read_own_environ", "/proc/self/environ", canary);
    read_file("read_database", "/data/gryt.db", canary);
    list_dir("list_storage", "/data");
    read_file("read_app", "/app/package.json", NULL);
    read_file("read_passwd", "/etc/passwd", NULL);
    list_dir("list_root", "/");

    for (int i = 0; i < 16; i++) chdir("..");
    attempt("escape_chroot", open("etc/passwd", O_RDONLY));
    chdir("/");

    attempt("create_file", open("/probe-was-here", O_CREAT | O_WRONLY, 0600));
    attempt("socket_inet", socket(AF_INET, SOCK_STREAM, 0));
    attempt("socket_unix", socket(AF_UNIX, SOCK_STREAM, 0));
    int pair[2];
    attempt("socketpair", socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    attempt("signal_worker", kill(1, 0));

    long traced = ptrace(PTRACE_SEIZE, 1, NULL, NULL); /* SEIZE doesn't stop the worker */
    attempt("ptrace_worker", (int)traced);
    if (traced == 0) ptrace(PTRACE_DETACH, 1, NULL, NULL);
    char peek[8];
    struct iovec local = {peek, sizeof peek}, remote = {(void *)0x10000, sizeof peek};
    ssize_t peeked = process_vm_readv(1, &local, 1, &remote, 1, 0);
    attempt("read_worker_memory", peeked >= 0 || errno == EFAULT ? 0 : -1); /* EFAULT got past the check */

    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) _exit(0);
    if (pid > 0) waitpid(pid, NULL, 0);
    attempt("fork", pid);

    char head[16];
    attempt("read_input", (int)read(3, head, sizeof head));
    attempt("write_input", (int)write(3, "x", 1));
    return 0;
}
