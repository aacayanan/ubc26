FROM python:3.12-alpine@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89

# Sandbox image for one F13 evaluation run.
#
# Pinned by manifest-list digest, not tag: a tag re-pulls and can silently
# change what a verdict means. The host refuses a tag-only SANDBOX_IMAGE for the
# same reason (`getSandboxEnv`).
#
# No `apk add` — every package is attack surface for zero payoff. The harness
# uses the Python 3.12 stdlib only.

# Trusted harness. Read-only and root-owned: the untrusted child runs as uid
# 1001 and must not be able to rewrite the code that judges it.
COPY main.py /opt/harness/main.py
COPY child.py /opt/harness/child.py
RUN chmod 0555 /opt/harness/main.py /opt/harness/child.py \
  && chown root:root /opt/harness /opt/harness/*.py

# The container starts as root by design. It is granted only
# CAP_SETUID/CAP_SETGID/CAP_KILL over an otherwise --cap-drop ALL set, so root's
# only extra power is dropping each test child to uid 1001 (and killing it).
# Without those caps the harness cannot create the uid boundary that keeps a
# solution out of /proc/<harness>.
#
# -I (isolated): ignore PYTHONPATH and the user site directory.
# -B: never write .pyc files into a read-only rootfs.
ENTRYPOINT ["python3", "-I", "-B", "/opt/harness/main.py"]