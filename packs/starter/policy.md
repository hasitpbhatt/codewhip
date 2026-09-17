# starter pack (v1) — pull with: codewhip pack pull starter
# Deny lines only. Denylist still wins over these; these win over the allowlist.
deny bash:npm publish *
deny bash:terraform apply *
deny bash:kubectl delete *
deny edit:.env
deny edit:.env.*
deny write:.env
deny write:.env.*
deny bash:git push origin main *
