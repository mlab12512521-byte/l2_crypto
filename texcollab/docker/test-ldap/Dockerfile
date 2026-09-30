# OpenLDAP directory used only by the server's LDAP integration tests.
# Build: docker build -t texcollab/test-ldap:dev docker/test-ldap
FROM ubuntu:24.04 AS runtime
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends slapd ldap-utils \
 && rm -rf /var/lib/apt/lists/*
COPY slapd.conf seed.ldif start.sh /ldap/
RUN chmod +x /ldap/start.sh
EXPOSE 389 636
CMD ["/ldap/start.sh"]
