// @vitest-environment node
//
// A host that names where its runtime publishes the commonest operations
// (`fast`) has `d[k]`, `d.get(k)`, `d.get(k, d)`, `x in c`, `x not in c`, `==`,
// `!=`, `s.strip()`, `sep.join(items)` and the builtins' `isinstance(v, cls)`
// and `id(v)` emitted as calls of it, with the engine's arguments. A slice, an
// ordered or a chained comparison, one of these calls with a keyword, a star or
// another count, another method, an `isinstance` or an `id` the module or the
// function binds, and every operation of a host that names none, stay the
// engine's own; and so does every compile after, even one that raised.
import { test, expect } from 'vitest';
import * as bryc from '../src/brycomp.js';

const host = {
    name: 'host',
    runtime: { jsGlobal: 'globalThis', liveExport: 'liveExport', pyExport: 'pyExport', pythonModule: 'pythonModule' }
};
const options = { name: 'probe', source: 'src/probe.py' };
const emitted = (body, fast) => bryc.compile(fast ? { ...host, fast: '$fastOps' } : host, `def f(d, k):\n    return ${body}\n`, options).module;

test.for([
    ['d[k]', '$B.$fastOps.item('],
    ['d.get(k)', '$B.$fastOps.get1('],
    ['d.get(k, 0)', '$B.$fastOps.get2('],
    ['k in d', '$B.$fastOps.member('],
    ['k not in d', '! $B.$fastOps.member('],
    ['d == k', '$B.$fastOps.eq('],
    ['d != k', '$B.$fastOps.ne('],
    ['isinstance(d, k)', '$B.$fastOps.isinstance('],
    ['id(d)', '$B.$fastOps.id('],
    ['d.strip()', '$B.$fastOps.strip0('],
    ['k.join(d)', '$B.$fastOps.join1(']
])('`%s` is emitted as %s', ([body, call]) => {
    expect(emitted(body, true)).toContain(call);
    expect(emitted(body, false)).not.toContain('$fastOps');
});

test.for([
    'd[1:2]', 'd < k', 'd == k == 1', 'd.get(k, default=0)', 'd.get(*k)', 'd.pop(k)', 'd.get()',
    'isinstance(d)', 'isinstance(d, k, 1)', 'isinstance(d, cls=k)', 'isinstance(*d)',
    'id()', 'id(d, k)', 'id(*d)', 'd.strip(k)', 'd.strip(chars=k)', 'k.join()', 'k.join(d, 1)', 'k.join(*d)'
])(
    '`%s` stays the engine own',
    (body) => {
        expect(emitted(body, true)).not.toContain('$fastOps');
    }
);

test.for([
    ['isinstance', 'the module', 'isinstance = len\ndef f(d, k):\n    return isinstance(d, k)\n'],
    ['isinstance', 'the function', 'def f(d, isinstance):\n    return isinstance(d, 1)\n'],
    ['id', 'the module', 'id = len\ndef f(d):\n    return id(d)\n'],
    ['id', 'the function', 'def f(d, id):\n    return id(d)\n']
])('an %s %s binds stays its own', ([, , source]) => {
    expect(bryc.compile({ ...host, fast: '$fastOps' }, source, options).module).not.toContain('$fastOps');
});

test('a compile after one that raised is the engine own', () => {
    expect(() => bryc.compile({ ...host, fast: '$fastOps' }, 'return 1\n', options)).toThrow();
    expect(emitted('d[k] == d.get(k)', false)).not.toContain('$fastOps');
});
