# Drift detection

A drift check looks at the latest run of each environment's `terraform-plan-<env>.yml` workflow. If `terraform plan -detailed-exitcode` exited with `2` (changes pending) — meaning the live infrastructure no longer matches the committed code — the environment is reported as drifted.

Set `terraformWorkspace.driftCheckMinutes` to a positive integer to enable scheduled checks; leave it at `0` to only check on demand.
