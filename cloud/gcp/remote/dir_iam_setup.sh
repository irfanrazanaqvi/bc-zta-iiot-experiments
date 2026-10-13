#!/bin/bash
# Runs on the "dir" VM: installs and starts the two real central identity services used as baselines.
#   Keycloak 26.4.0 (Docker, dev-mode single node, embedded H2)  -> http://<dir>:8080   admin / admin, realm is created by run_iam.js
#   OpenLDAP slapd (Debian package)                               -> ldap://<dir>:389   base dc=bczta,dc=local  admin cn=admin,dc=bczta,dc=local / bczta-ldap
# Idempotent: safe to run again.
set -euo pipefail
KC_VERSION="${KC_VERSION:-26.4.0}"

# ---- OpenLDAP ----
if ! dpkg -s slapd >/dev/null 2>&1; then
  cat <<'EOD' | sudo debconf-set-selections
slapd slapd/password1 password bczta-ldap
slapd slapd/password2 password bczta-ldap
slapd slapd/domain string bczta.local
slapd shared/organization string bczta
slapd slapd/backend select MDB
slapd slapd/purge_database boolean true
slapd slapd/move_old_database boolean true
slapd slapd/no_configuration boolean false
EOD
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y slapd ldap-utils >/dev/null
fi
sudo systemctl enable --now slapd
for i in $(seq 1 30); do ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=bczta,dc=local" -w bczta-ldap -b "dc=bczta,dc=local" -s base dn >/dev/null 2>&1 && break; sleep 2; done
ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=bczta,dc=local" -w bczta-ldap -b "dc=bczta,dc=local" -s base dn >/dev/null || { echo "slapd does not answer" >&2; exit 1; }
echo "slapd ok"

# ---- Keycloak ----
if ! sudo docker inspect kc >/dev/null 2>&1; then
  sudo docker pull "quay.io/keycloak/keycloak:$KC_VERSION" >/dev/null
  sudo docker run -d --name kc -p 8080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin "quay.io/keycloak/keycloak:$KC_VERSION" start-dev >/dev/null
else
  sudo docker start kc >/dev/null
fi
kc_code() { curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/realms/master || true; }
for i in $(seq 1 120); do [ "$(kc_code)" = "200" ] && break; sleep 3; done
[ "$(kc_code)" = "200" ] || { echo "keycloak does not answer" >&2; sudo docker logs --tail 30 kc >&2; exit 1; }
# allow the admin login over plain http from the other VMs (private network only)
sudo docker exec kc /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null 2>&1 \
  && sudo docker exec kc /opt/keycloak/bin/kcadm.sh update realms/master -s sslRequired=NONE >/dev/null 2>&1 || echo "note: could not relax master sslRequired (probably not needed on a private network)"
echo "keycloak ok"
