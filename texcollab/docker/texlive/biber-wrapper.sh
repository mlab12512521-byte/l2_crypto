#!/bin/bash
# Run biber inside the sandbox. biber is a PAR-packed program: it needs a
# writable cache directory (for a lock file) from which it executes unpacked
# shared libraries. The pre-unpacked cache from the image is copied into the
# dedicated /par tmpfs (the only exec-allowed writable mount) on first use.
set -eu
if [ ! -e /par/.ready ]; then
  cp -R /opt/biber-par/. /par/
  touch /par/.ready
fi
export PAR_GLOBAL_TEMP=/par
exec /usr/bin/biber "$@"
