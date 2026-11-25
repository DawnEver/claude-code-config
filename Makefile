# This repo's own Makefile (the family Makefile contract retired 2026-11-24). Its tests are node:test files, so
# `verify` runs `npm test` -- the same command the forge's base part runs (pyproject [tool.lab_commons.tests]).
.DEFAULT_GOAL := all

.PHONY: all clean install install-dev test test-parallel verify

all: verify

clean:
	rm -rf output node_modules

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
