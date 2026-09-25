#!/bin/sh
set -eu

# A second jail around the probe, started the same way, before the image's own entrypoint.
env -i /usr/local/bin/ffjail serve /run/gryt-ff/probe.sock /opt/gryt-ff/jail /opt/gryt-ff/probe 1002 1002 1001
exec /usr/local/bin/gryt-entrypoint "$@"
