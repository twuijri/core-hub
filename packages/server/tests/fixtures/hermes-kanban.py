"""Run the real `hermes kanban` from a checkout of Hermes's source, stdlib only.

The bridge's integration test points PYTHONPATH at the pinned release and calls this in
place of the `hermes` executable, so the argv the hub sends is parsed by Hermes's own
argparse and executed by Hermes's own command code.
"""
import argparse
import sys

import hermes_cli.kanban as kcli
import hermes_cli.kanban_parser as kp

root = argparse.ArgumentParser(prog="hermes")
kp.build_parser(root.add_subparsers(dest="cmd"))
sys.exit(kcli.kanban_command(root.parse_args(["kanban", *sys.argv[1:]])) or 0)
