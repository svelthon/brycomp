// @vitest-environment node
//
// What a module exports: the list `__all__` declares, what of it the module
// cannot export, each name exported live, and the body run when the module is
// imported.
import { test, expect } from 'vitest';
import * as bryc from '../src/brycomp.js';

const host = {
    name: 'host',
    runtime: { jsGlobal: 'globalThis', liveExport: 'liveExport', pyExport: 'pyExport', pythonModule: 'pythonModule' }
};
const NS = bryc.NS;
const next = bryc.NEXT_VALUE;

// **What a module exports is what `__all__` holds once its top-level
// statements have run**, as `from m import *` obeys it: each statement that
// writes it is run as Python runs it when it is written with literals,
// `__all__` and the builtins that only read, the last one counts, an entry
// that is not a string is refused, a name listed twice is exported once. A
// write a static reading cannot follow is refused, under the host's name, on
// its line. No `__all__`, no list.
const source = 'src/probe.py';

const exported = (src, lineOffset = 0) => {
    const { root, table } = bryc.compile(host, src, { name: 'probe', source });

    return bryc.declaredExports(host, root._ast, table, source, lineOffset, src);
};

test('the list the module ends with, run as Python runs it', () => {
    const src = [
        'def load(): pass',
        'def save(): pass',
        '__all__ = ["gone"]',
        '__all__ = ["load", "save"]',
        '__all__ += sorted(["load"])'
    ].join('\n');

    // The last list, its `load` exported once, at the line of the statement
    // that last set it.
    expect(exported(src, 4)).toEqual({ names: ['load', 'save'], line: 9 });
});

// Left out, it exported nothing and said nothing, where CPython's `from m
// import *` raises `TypeError: Item in __all__ must be str`.
test('an entry that is not a string is refused on the line that set the list', () => {
    expect(() => exported('def load(): pass\n__all__ = ["load", 3]\n', 4)).toThrow(
        'host — `__all__` lists `3`, an `int`, and an entry of `__all__` is a name, a string, as Python\'s `from m import *` requires (src/probe.py:6)'
    );
});

test('a string is a list of its characters, as `+=` makes it', () => {
    expect(exported('__all__ = ["a"]\n__all__ += "bc"\n').names).toEqual(['a', 'b', 'c']);
});

test('no `__all__`, no list, and one that `del` removes is none either', () => {
    expect(exported('def load(): pass\n')).toBe(null);
    expect(exported('__all__ = ["load"]\ndel __all__\n')).toBe(null);
});

test('a list computed from a name is refused on its line, under the host\'s name', () => {
    let error;

    try {
        exported('names = ["load"]\n__all__ = names\n', 10);
    } catch (caught) {
        error = caught;
    }

    expect(error.message).toMatch(/^host — `__all__` is computed from `names`, and the export list is read from the source/);
    expect(error.start).toEqual({ line: 12, column: 0 });
});

test('a list bound to a second target is refused, which a change through that name escapes', () => {
    for (const bound of ['__all__ = alias = ["a"]', 'alias, __all__ = [["a"]] * 2', '[alias, *__all__] = [["a"]] * 2']) {
        expect(() => exported(`def a(): pass\ndef b(): pass\n${bound}\nalias.append("b")\n`)).toThrow(
            /^host — `__all__` is assigned to another target as well, and the export list is read from the source/
        );
    }
});

// A statement run for the list that binds another name hands that name what it
// binds: the list itself, or a list it holds, is then changed through it out
// of sight. A string, `last = __all__.pop()`, changes nothing of it.
test('a statement run for the list that binds another name to the list, or to a list it holds, is refused', () => {
    const bound = [
        '__all__ = ["a"]\nY = (__all__.append("b"), __all__)[1]\nY.append("c")\n',
        '__all__ = [["a"]] * 2\nY = __all__.pop()\nY.append("b")\n__all__ = __all__[0]\n',
        '__all__ = [{"k": ["a"]}]\nY = __all__[0].get("k")\nY.append("b")\n__all__ = __all__[0]["k"]\n'
    ];

    for (const src of bound) {
        expect(() => exported(`def a(): pass\ndef b(): pass\n${src}`)).toThrow(
            /^host — `__all__` is handed on to `Y`, where this file cannot follow what is done to it/
        );
    }
    expect(exported('def a(): pass\ndef b(): pass\n__all__ = ["a", "b"]\nlast = __all__.pop()\n').names).toEqual(['a']);
    expect(exported('def a(): pass\ndef b(): pass\n__all__ = [["a"], ["b"]]\nY = __all__.pop()\n__all__ = __all__[0]\n').names).toEqual(['a']);
});

test('a list read off the list is handed on as the list is', () => {
    expect(() =>
        exported('def a(): pass\ndef b(): pass\n__all__ = [["a"]]\nalias = __all__[0]\nalias.append("b")\n__all__ = __all__[0]\n')
    ).toThrow(/^host — `__all__` is handed on where this file cannot follow what is done to it/);
    expect(exported('def a(): pass\n__all__ = ["a"]\nprint(__all__[0])\n').names).toEqual(['a']);
});

// And a list inside the list, changed in place where it stands, changes what
// the list ends with: run as Python runs it, where the analysis left it out and
// exported `["a"]` of a module that ends with `["a", "b"]`.
test('a change to a list inside the list is run as Python runs it', () => {
    const nested = (change) => `def a(): pass\ndef b(): pass\n__all__ = [["a"]]\n${change}\n__all__ = __all__[0]\n`;

    for (const change of ['__all__[0].append("b")', '__all__[0].extend(["b"])', '__all__[0].insert(1, "b")', '__all__[0][1:] = ["b"]', '__all__[0] += ["b"]']) {
        expect(exported(nested(change)).names).toEqual(['a', 'b']);
    }
    expect(exported(nested('__all__[0].count("a")')).names).toEqual(['a']);
    expect(exported('def a(): pass\ndef b(): pass\n__all__ = [["a", "b"]]\ndel __all__[0][1]\n__all__ = __all__[0]\n').names).toEqual(['a']);
});

// The name a list of names holds there, as a string, which changes nothing.
test('a method of str on an item of the list is a read', () => {
    const reads = ['print(__all__[0].upper())', 'def f():\n    return __all__[0].upper()', 'class C:\n    NAME = __all__[0].title()', 'if True:\n    print(__all__[-1].endswith("b"))'];

    for (const read of reads) {
        expect(exported(`def a(): pass\ndef b(): pass\n__all__ = ["a", "b"]\n${read}\n`).names).toEqual(['a', 'b']);
    }
});

// A list that only ever held strings hands on its items, and a copy of them,
// as they are; one a statement made hold a list does not.
test('an item, a slice or an unpacking of a list of strings is no hand-off', () => {
    for (const read of ['x = __all__[0]', 'x = __all__[:]', 'first, = __all__', 'first, *rest = __all__', 'x = __all__.copy()']) {
        expect(exported(`def a(): pass\n__all__ = ["a"]\n${read}\n`).names).toEqual(['a']);
    }
    for (const read of ['x = __all__[:]', 'first, = __all__', 'x = __all__.copy()', 'x = __all__.__getitem__(0)']) {
        expect(() => exported(`def a(): pass\ndef b(): pass\n__all__ = [["a"]]\n${read}\nx[0].append("b")\n__all__ = __all__[0]\n`)).toThrow(
            /^host — `__all__` is handed on where this file cannot follow what is done to it/
        );
    }
    expect(() => exported('def a(): pass\n__all__ = ["a"]\nx = __all__\n')).toThrow(/is handed on where/);
});

// A method of a string written out reads what it is given; one of a name may
// be anything's.
test('the list handed to a method of a string written out is read', () => {
    for (const read of ['x = ", ".join(__all__)', 'def f():\n    return "\\n".join(__all__)', 'print("{}".format(__all__))']) {
        expect(exported(`def a(): pass\n__all__ = ["a"]\n${read}\n`).names).toEqual(['a']);
    }
    expect(() => exported('def a(): pass\n__all__ = ["a"]\nsep = ", "\nx = sep.join(__all__)\n')).toThrow(/is handed on where/);
});

// An operator hands the list to its other operand's method, which an author's
// object may keep it in: `holder + __all__` calls its `__add__`, `__all__ +
// holder` its `__radd__`, `__all__ == holder` its `__eq__`. A constant or a
// display keeps nothing, nor does `is`, nor `in` looking among the list's items.
test('the list an operator hands to an operand of the author’s is handed on, to a constant it is read', () => {
    const module = (read) => `def a(): pass\nholder = []\n__all__ = ["a"]\n${read}\n`;

    for (const read of ['x = holder + __all__', 'x = __all__ + holder', 'x = __all__ == holder', 'x = 1 < holder < __all__', 'x = __all__ in holder']) {
        expect(() => exported(module(read))).toThrow(/is handed on where/);
    }
    for (const read of ['x = __all__ + ["b"]', 'x = (holder,) + __all__', 'x = __all__ == ["a"]', 'x = "a" in __all__', 'x = holder in __all__', 'x = __all__ is holder', 'x = "%s" % __all__']) {
        expect(exported(module(read)).names).toEqual(['a']);
    }
});

// What a copy holds or a loop takes is the list's own items: a list inside it
// is changed through them. A read stands where the list holds strings alone, or
// not: at the top of the module, after the statements before it, and in a
// function, after every statement from its definition on.
test('a copy or a loop that takes the items of a list holding a list is a hand-off', () => {
    const nested = (change) => `def a(): pass\ndef b(): pass\n__all__ = [["a"]]\n${change}\n__all__ = __all__[0]\n`;
    const reads = [
        'list(__all__)[0]', 'tuple(__all__)[0]', 'sorted(__all__)[0]', '[*__all__][0]', 'next(iter(__all__))', 'next(reversed(__all__))',
        'next(enumerate(__all__))[1]', 'next(zip(__all__))[0]', 'min(__all__)', 'max(__all__)', '(__all__ + [])[0]', 'next(x for x in __all__)'
    ];

    for (const read of reads) {
        expect(() => exported(nested(`${read}.append("b")`))).toThrow(
            /^host — `__all__` is handed on where this file cannot follow what is done to it, and a copy would share what it holds, which is more than strings/
        );
        expect(exported(`def a(): pass\ndef b(): pass\n__all__ = ["a", "b"]\nx = ${read}\n`).names).toEqual(['a', 'b']);
    }
    expect(() => exported(nested('for x in __all__:\n    x.append("b")'))).toThrow(/is handed on where/);
    expect(() => exported(`def f():\n    return list(__all__)\n${nested('')}`)).toThrow(/is handed on where/);
    expect(exported(`${nested('')}for name in __all__:\n    print(name)\ndef f():\n    return list(__all__)\n`).names).toEqual(['a']);
});

// A copy one level further in holds what that level holds: of a list inside
// the list, strings, which nothing changes. The list itself is still handed
// on, and so is a copy of a list holding a list in turn.
test('a copy of a list of strings inside the list is no hand-off, the list itself is', () => {
    const nested = (read) => `def a(): pass\ndef b(): pass\n__all__ = [["a"]]\n${read}\n__all__ = __all__[0]\n`;

    for (const read of ['alias = list(__all__[0])', 'alias = __all__[0].copy()', 'alias = __all__[0][:]', 'first, *rest = __all__[0]']) {
        expect(exported(nested(read)).names).toEqual(['a']);
    }
    expect(() => exported(nested('alias = __all__[0]'))).toThrow(/is handed on where/);
    expect(() => exported('def a(): pass\n__all__ = [[["a"]]]\nalias = list(__all__[0])\n__all__ = __all__[0][0]\n')).toThrow(
        /is handed on where this file cannot follow what is done to it, and a copy would share what it holds/
    );
    expect(exported('def a(): pass\n__all__ = ("a",)\nalias = __all__\n').names).toEqual(['a']);
});

// A JavaScript import spelled like a builtin that only reads is the import, not
// the builtin: the list it makes is not known before the module runs.
test('a list made by a JavaScript import spelled like a builtin is refused, as one made by any name', () => {
    for (const name of ['list', 'sorted']) {
        expect(() => exported(`__js__ = {"./api.mjs": ["${name}"]}\ndef a(): pass\n__all__ = ${name}(["a"])\n`)).toThrow(
            new RegExp(`\`__all__\` is computed from \`${name}\``)
        );
    }
    expect(exported('def a(): pass\n__all__ = list(["a"])\n').names).toEqual(['a']);
});

test('a raise at import is refused where it is raised', () => {
    expect(() => exported('__all__ = ("load",)\n__all__.append("x")\n')).toThrow(
        /^host — Python raises `AttributeError: 'tuple' object has no attribute 'append'` here when the module is imported, so `__all__` has no value to export \(src\/probe\.py:2\)$/
    );
});

// **What `__all__` lists that the module cannot export is refused at the line
// of the list**, under the host's name: a name the module never binds, a word
// JavaScript reserves, a text that is no name. With a `from m import *`, a name
// not yet bound waits, and is refused once the body has run if the star did not
// bring it.
const checks = (names, more = {}) =>
    bryc.exportChecks(host, {
        declaration: { names, line: 4 },
        declared: ['load'],
        binds: new Set(['save']),
        jsImported: ['navigate'],
        starred: false,
        source: 'src/a.py',
        ...more
    });

test('a list of names the module binds, declares or imports is exported as it stands', () => {
    expect(checks(['load', 'save', 'navigate'])).toEqual({ unbound: [], line: 4, listedAt: 'src/a.py:4' });
    expect(checks(null, { declaration: null })).toEqual({ unbound: [], line: undefined, listedAt: 'src/a.py' });
});

test('a name the module never binds is refused at the list', () => {
    expect(() => checks(['load', 'lost'])).toThrow(/^host — `__all__` names `lost`, which this module never binds \(src\/a\.py:4\)\./);
});

test('a word JavaScript reserves, or a text that is no name, cannot be exported under it', () => {
    expect(() => checks(['default'], { binds: new Set(['default']) })).toThrow(/names `default`, which JavaScript reserves, so the module cannot export it/);
    expect(() => checks(['two words'], { starred: true })).toThrow(/names `two words`, which is not a name/);
});

test('with a star import, a name not yet bound waits, and is refused once the body has run', () => {
    const { unbound, listedAt } = checks(['load', 'later'], { starred: true });

    expect(unbound).toEqual(['later']);
    expect(bryc.unboundRefusals(host, unbound, listedAt)).toEqual([
        `if (${NS}["later"] === undefined) throw new globalThis.Error(${JSON.stringify(
            'host — `__all__` names `later`, which this module never binds (src/a.py:4). A module exports what it defines: check the spelling, or remove it from the list.'
        )});`
    ]);
});

// **A module exports by name, live**: each name a variable of its own, filled
// as the body binds it, the value crossing as the host's runtime hands Python's
// values to JavaScript; a name only JavaScript brings re-exported as
// JavaScript's own binding; and no default export. A module that exports
// nothing writes no `export`.
const module = { exported: ['load', 'navigate'], jsImported: ['navigate'], source: 'src/+page.server.py' };

test('each name exported live, a JavaScript import as its own binding', () => {
    expect(bryc.moduleExports(host, module)).toEqual(['let __export_load;', 'export { __export_load as load, navigate };']);
    expect(bryc.liveExportLines(host, module)).toEqual([
        `liveExport(${NS}, "load", (__value) => { __export_load = pyExport(__value, "load — src/+page.server.py"); });`
    ]);
});

// An import named like one of the framework's own words is held under another
// variable (`host.runes`), and re-exported from it under its own name.
test('an import named like one of the framework’s words is re-exported from its variable', () => {
    const runes = { ...host, runes: ['effect'] };

    expect(bryc.moduleExports(runes, { exported: ['effect'], jsImported: ['effect'] })).toEqual(['export { __import_effect as effect };']);
});

test('a module that exports nothing writes no export', () => {
    expect(bryc.moduleExports(host, { exported: [], jsImported: [] })).toEqual([]);
});

// **A module's body runs when it is imported, not when it is evaluated**: a
// function the module exports by default, published under the module's Python
// name, runs what the host hands it, and takes a new namespace when a body that
// raised is imported again, with what the host renews beside it. An eager
// module runs it as it is evaluated, and exports no default. A name no
// `import` can write is published under none.
test('a default export that runs the body when the module is imported', () => {
    expect(bryc.moduleLoad(host, { name: 'cart', run: [`init(${NS});`, '', 'done();'], renewed: ['roots = fresh();'] })).toEqual([
        '',
        `export default pythonModule(${NS}, "cart", (${next}) => { ${NS} = ${next}; roots = fresh(); }, () => {`,
        `    init(${NS});`,
        '',
        '    done();',
        '});'
    ]);
});

test('an eager module runs it as it is evaluated, and a name no import writes is none', () => {
    const lines = bryc.moduleLoad(host, { name: '+page.server', eager: true, run: ['go();'] });

    expect(lines[1]).toBe(`pythonModule(${NS}, null, (${next}) => { ${NS} = ${next}; }, () => {`);
    expect(lines.at(-1)).toBe('})();');
});

// A name each part of which is an identifier is one `import` writes, a dotted
// one too; a part empty or no identifier makes it none.
test('a qualified module name is published, and one no import writes is none', () => {
    const published = (name) => bryc.moduleLoad(host, { name, run: [] })[1].split(', ')[1];

    expect(['shop.worker', 'a.sub.worker', 'équipe.outil', 'cart'].map(published)).toEqual([
        '"shop.worker"',
        '"a.sub.worker"',
        '"équipe.outil"',
        '"cart"'
    ]);
    expect(['+page.server', 'pkg..worker', '.worker', 'worker.'].map(published)).toEqual(['null', 'null', 'null', 'null']);
});
