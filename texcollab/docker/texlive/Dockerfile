# TeXCollab compile sandbox: TeX Live plus a fixed entrypoint.
#
# Never run this image directly with user-controlled options; the compile
# worker starts it with strict isolation (see docs/security-model.md):
#   --network none --read-only --cap-drop ALL --security-opt no-new-privileges
#   --tmpfs /work --tmpfs /tmp --pids-limit --memory --cpus --user 10000:10000
#
# Base image: the official TeX Live images (scheme-full by default so that
# "arbitrary normal LaTeX packages" work). Pin a dated tag in production,
# e.g. texlive/texlive:TL2025-historic or a digest, for reproducible builds.
ARG TEXLIVE_IMAGE=texlive/texlive:latest-full
FROM ${TEXLIVE_IMAGE}

# Build the LuaTeX font-name database and format files once, into the
# system-wide (read-only at runtime) TEXMFSYSVAR tree, so lualatex does not
# rebuild them in every short-lived sandbox.
RUN export TEXMFVAR="$(kpsewhich -var-value TEXMFSYSVAR)" \
 && (luaotfload-tool --update --force >/dev/null 2>&1 || true) \
 && (mtxrun --generate >/dev/null 2>&1 || true)

# Biber is a PAR-packed executable that unpacks itself before running. Unpack
# it once here; at runtime texcollab-biber copies the cache into the /par
# tmpfs (see biber-wrapper.sh) instead of unpacking from scratch.
ENV PAR_GLOBAL_TEMP=/opt/biber-par
RUN mkdir -p /opt/biber-par && (biber --version >/dev/null 2>&1 || true) && chmod -R a+rX /opt/biber-par

COPY latexmkrc /etc/texcollab/latexmkrc
COPY compile.sh /usr/local/bin/texcollab-compile
COPY biber-wrapper.sh /usr/local/bin/texcollab-biber
RUN chmod 0555 /usr/local/bin/texcollab-compile /usr/local/bin/texcollab-biber \
 && chmod 0444 /etc/texcollab/latexmkrc \
 && (getent passwd 10000 >/dev/null || useradd --uid 10000 --user-group --no-create-home --home-dir /tmp --shell /usr/sbin/nologin texuser)

USER 10000:10000
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/texcollab-compile"]
