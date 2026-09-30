#!/bin/sh
set -e
if [ -f /certs/cert.pem ]; then
  printf 'TLSCertificateFile /certs/cert.pem\nTLSCertificateKeyFile /certs/key.pem\n' > /tmp/tls.conf
  urls="ldap:/// ldaps:///"
else
  : > /tmp/tls.conf
  urls="ldap:///"
fi
mkdir -p /var/lib/ldap-test
slapadd -f /ldap/slapd.conf -l /ldap/seed.ldif
exec slapd -f /ldap/slapd.conf -h "$urls" -d 0
