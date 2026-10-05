#!/bin/sh
set -eu

# Root only long enough to start the ffmpeg jail; the worker itself runs as gryt.
# env -i: the jail's daemon never holds the S3 keys either.
if [ "$(id -u)" = 0 ]; then
  socket="${FFJAIL_SOCKET:-/run/gryt-ff/ffjail.sock}"
  if ! env -i /usr/local/bin/ffjail serve "$socket" /opt/gryt-ff/jail /ffmpeg 1002 1002 1001; then
    echo "The ffmpeg jail did not start, so videos get no poster" >&2
  fi
  image_socket="${IMAGEJAIL_SOCKET:-/run/gryt-ff/imagejail.sock}"
  if ! env -i /usr/local/bin/ffjail serve "$image_socket" /opt/gryt-image/jail /usr/local/bin/node 1002 1002 1001; then
    echo "The image jail did not start, so new uploads stay in quarantine" >&2
  fi
  exec setpriv --reuid=gryt --regid=gryt --clear-groups --no-new-privs -- "$@"
fi

echo "Not started as root, so the ffmpeg jail is off and videos get no poster" >&2
exec "$@"
