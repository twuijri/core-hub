# Specifications written from observation

One file per feature we are about to build, written by an **observer** who used
the product being learned from (ADR 0012). An implementer builds from the file
and does not open that product's source.

Each specification states, at the top: what was observed, how (used it / read
its documentation / captured its traffic), and when. Then: the screens and
their states, the fields and their rules, the edge cases, the error text the
user sees, and a section naming what we deliberately do differently and why.
