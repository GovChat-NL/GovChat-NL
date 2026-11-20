#!/bin/sh
# Checks from the outside that you cannot get in without the organisation's account.
# Safe against any environment: the requests carry invalid data and change nothing.
#
#   scripts/check.sh <base-url>
set -u

base=${1:?usage: check.sh <base-url>}
failed=0

expect() { # expected-status method path description
  got=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -A 'Mozilla/5.0 govchat-check' -X "$2" \
    -H 'Content-Type: application/json' \
    -d '{"email":"nobody@example.test","password":"invalid","name":"x","confirm_password":"invalid"}' \
    "$base$3")
  if [ "$got" = "$1" ]; then echo "OK    $4 ($got)"; else echo "FAIL  $4: expected $1, got $got"; failed=1; fi
}

expect 200 GET  /health                       'the application is reachable'
expect 403 POST /api/auth/login               'local login is refused'
expect 403 POST /api/auth/register            'creating an account is refused'
expect 403 POST /api/auth/requestPasswordReset 'password reset is refused'
expect 401 GET  /api/user                     'no user data without login'
expect 401 GET  /api/convos                   'no conversations without login'

exit $failed
