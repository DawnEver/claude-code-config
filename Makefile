# The family's target headers (dev_lab.dev._famconfig_rows.MAKEFILE_BASE, a REQUIRED base: the names are the
# family's, every recipe is this repo's). This repo's tests are node:test files, so `verify` runs `npm test` --
# the same command the forge's base part runs (pyproject [tool.lab_commons.tests]) -- and not the base's
# `python -m dev_lab.dev.verify`, which is ruff plus pytest and would check nothing here (declared drop in
# scripts/_famconfig.py).
.DEFAULT_GOAL := all

.PHONY: all clean fmt install install-dev lint test test-parallel verify

all: verify

clean:
	rm -rf output node_modules

# No formatter or linter is declared for this repo's JavaScript; the targets exist so the family contract holds.
fmt:

lint:

install:
	npm install

install-dev: install
	uv sync --all-groups
	uv run python -m dev_lab.dev.hook_install --install

test:
	npm test

# node --test already runs its files in parallel processes.
test-parallel: test

verify:
	npm test
