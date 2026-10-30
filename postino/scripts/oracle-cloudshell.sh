#!/bin/bash
# Create a free Oracle server for Postino and install it, from Oracle Cloud Shell.
#
# In the Oracle console, open Cloud Shell (the ">_" icon at the top right), then:
#   curl -fsSL https://raw.githubusercontent.com/emanuelezamboni/various/main/postino/scripts/oracle-cloudshell.sh | bash
#
# It creates (or reuses) a network with ports 22/80/443 open, an Always Free
# Ampere server (2 OCPU, 12 GB, Ubuntu 24.04), and runs scripts/install.sh on it.
# Safe to run again: existing pieces named "postino-*" are reused.
set -euo pipefail

main() {
  say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
  die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
  q() { oci "$@" 2>/dev/null | tr -d '"' | sed 's/^null$//'; }
  command -v oci >/dev/null || die "run this in Oracle Cloud Shell (the >_ icon at the top of the console)"

  DOMAIN="${POSTINO_DOMAIN:-}"
  if [ -z "$DOMAIN" ] && [ -r /dev/tty ]; then
    read -r -p "Address for Postino (e.g. mail.example.com): " DOMAIN </dev/tty || true
  fi
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%/}"
  [ -n "$DOMAIN" ] || die "an address is needed"

  # ---- where to create things: the root compartment of this account ----------------
  C="${OCI_TENANCY:-}"
  [ -n "$C" ] || C="$(q os ns get-metadata --query 'data."default-s3-compartment-id"' --raw-output)"
  [ -n "$C" ] || die "could not find your account (tenancy) id"

  # ---- network --------------------------------------------------------------------------
  say "Network"
  VCN="$(q network vcn list -c "$C" --display-name postino-vcn --query 'data[0].id' --raw-output)"
  if [ -z "$VCN" ]; then
    VCN="$(q network vcn create -c "$C" --cidr-block 10.0.0.0/16 --display-name postino-vcn --dns-label postino --wait-for-state AVAILABLE --query data.id --raw-output)"
  fi
  [ -n "$VCN" ] || die "could not create the network"
  IGW="$(q network internet-gateway list -c "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output)"
  if [ -z "$IGW" ]; then
    IGW="$(q network internet-gateway create -c "$C" --vcn-id "$VCN" --is-enabled true --display-name postino-igw --wait-for-state AVAILABLE --query data.id --raw-output)"
  fi
  RT="$(q network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)"
  oci network route-table update --rt-id "$RT" --force \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
  SL="$(q network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)"
  oci network security-list update --security-list-id "$SL" --force --ingress-security-rules '[
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"17","udpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"1","icmpOptions":{"type":3,"code":4}}]' >/dev/null
  SUB="$(q network subnet list -c "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output)"
  if [ -z "$SUB" ]; then
    SUB="$(q network subnet create -c "$C" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 --display-name postino-subnet --dns-label main --wait-for-state AVAILABLE --query data.id --raw-output)"
  fi
  [ -n "$SUB" ] || die "could not create the subnet"

  # ---- SSH key (kept in Cloud Shell) -------------------------------------------------
  mkdir -p ~/.ssh
  [ -f ~/.ssh/postino ] || ssh-keygen -t ed25519 -f ~/.ssh/postino -N "" -q -C postino

  # ---- server ----------------------------------------------------------------------------
  INST="$(q compute instance list -c "$C" --display-name postino --lifecycle-state RUNNING --query 'data[0].id' --raw-output)"
  if [ -z "$INST" ]; then
    say "Finding the Ubuntu 24.04 image"
    IMG="$(q compute image list -c "$C" --all --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
      --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC \
      --query 'data[?!contains("display-name", `"Minimal"`)] | [0].id' --raw-output)"
    [ -n "$IMG" ] || die "could not find the Ubuntu 24.04 image"
    ADS="$(q iam availability-domain list -c "$C" --query 'join(`" "`, data[].name)' --raw-output)"
    say "Creating the free server (Ampere, 2 OCPU, 12 GB). Oracle sometimes has no free capacity: this retries for up to 30 minutes."
    for attempt in $(seq 1 30); do
      for AD in $ADS; do
        if INST="$(oci compute instance launch -c "$C" --availability-domain "$AD" --display-name postino \
            --shape VM.Standard.A1.Flex --shape-config '{"ocpus":2,"memoryInGBs":12}' \
            --image-id "$IMG" --subnet-id "$SUB" --assign-public-ip true --boot-volume-size-in-gbs 50 \
            --ssh-authorized-keys-file ~/.ssh/postino.pub --wait-for-state RUNNING \
            --query data.id --raw-output 2>/tmp/postino-launch.err)"; then
          break 2
        fi
        INST=""
        if ! grep -qi "capacity" /tmp/postino-launch.err; then
          cat /tmp/postino-launch.err >&2
          die "Oracle refused to create the server (see above)"
        fi
      done
      echo "  no free capacity right now (attempt $attempt/30), retrying in 60 s..."
      sleep 60
    done
    [ -n "$INST" ] || die "still no free capacity after 30 minutes; run this command again later"
  fi
  IP="$(q compute instance list-vnics --instance-id "$INST" --query 'data[0]."public-ip"' --raw-output)"
  [ -n "$IP" ] || die "the server has no public IP"
  say "Server running at $IP"

  # ---- install Postino on it -----------------------------------------------------------
  say "Waiting for the server to finish booting"
  SSH="ssh -i $HOME/.ssh/postino -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ubuntu@$IP"
  for _ in $(seq 1 60); do $SSH true 2>/dev/null && break; sleep 5; done
  $SSH 'cloud-init status --wait >/dev/null 2>&1 || true'
  say "Installing Postino (5-10 minutes)"
  $SSH -t "curl -fsSL https://raw.githubusercontent.com/emanuelezamboni/various/main/postino/scripts/install.sh | POSTINO_DOMAIN='$DOMAIN' bash"

  cat <<EOF

All done on Oracle's side. Last step, at your domain provider (vhosting panel):

  Add a DNS record   type A   name ${DOMAIN%%.*}   value $IP

Within a few minutes https://$DOMAIN opens Postino. Use the setup code printed above.
To reach the server again later, from Cloud Shell:   ssh -i ~/.ssh/postino ubuntu@$IP
EOF
}

main "$@"
