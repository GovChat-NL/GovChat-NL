"""Compatibility renderer: preserve policies without adding the reverted guard.

The extracted-text rule activated model-bound locator traversal for all agent
requests, including plain text. Adapter quality validation remains independent.
"""
import argparse
import copy
import pathlib

import yaml

def with_quality_policy(source):
    # Do not remove or weaken caller-owned policies, either. The operational
    # rollback removes only our verified delta against its private baseline.
    return copy.deepcopy(source)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        raise ValueError('refusing to overwrite source configuration')
    source = yaml.safe_load(args.source.read_text())
    args.output.write_text(yaml.safe_dump(with_quality_policy(source), sort_keys=False, allow_unicode=True))
    args.output.chmod(0o644)
