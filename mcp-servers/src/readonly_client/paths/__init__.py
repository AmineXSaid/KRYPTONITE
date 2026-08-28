"""Every REST path every server uses, one module per product.

This directory exists to be audited. A path written inline at its call site
gets copied; the copy is what drifts when an instance turns out to be Cloud
rather than Data Center, or GitLab 15 rather than 17. Keeping them here means a
wrong assumption is a one-line fix in a file whose whole job is to be read.

Each module carries, per path:

    * the documentation URL it came from
    * a status - CONFIRMED for a shape corroborated as correct for the
      deployment we target, NEEDS-PROBE for one that is standard but unverified
      against YOUR instance

Nothing here is confirmed against your instance until ``probe.py`` says so.
That is stated per module rather than assumed, because a plausible-looking URL
that 404s in production is exactly the failure this package refuses to ship.

Deliberately NOT re-exported at package level. ``from ..paths import
JIRA_SEARCH`` would let a Jenkins module reach a Jira constant without saying
so; ``from ..paths.jira import SEARCH`` cannot be written by accident.
"""
