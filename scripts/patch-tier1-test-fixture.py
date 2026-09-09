from pathlib import Path

p = Path('scripts/scheduler-stability-test.mjs')
s = p.read_text()
old = "function node(id, { concurrency = 2, rpm = 100, models = { m1: 'up-x' } } = {}) {"
new = "function node(id, { concurrency = 2, rpm = 0, models = { m1: 'up-x' } } = {}) {"
if old not in s:
    raise SystemExit('test fixture anchor missing')
p.write_text(s.replace(old, new, 1))
