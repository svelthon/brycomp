// The Python a template's expressions compile to: one function per expression,
// which the template's pass appends to the module under a name of its own
// (`EXPR_PREFIX`), and a tool for a host whose template reads a key with a dot
// as well as an attribute (`templateDots`).
import { engine } from './translation.js';
import { bindsHere } from './scopes.js';
import { refuse } from './errors.js';

// The hidden functions the template's pass appends, one per expression it
// compiled. The pass names them so, and Brycomp reads them by it; the two have to
// agree. After the prefix, the pass may say how the value is read (`set_` for
// the write half of a binding), and a `_late` at the end says the function's
// parameters arrive as functions.
const EXPR_PREFIX = '__brycomp_expr_';

// The value a write is handed (`templateDots`), under a name of the compiler's.
const GIVEN = '__brycomp_given';

// The names a write through a dot is made plain with (`plainWrites`).
const OBJECT = '__brycomp_object';
const VALUE = '__brycomp_value';
const PART = '__brycomp_part_';

// The writes through a dot that a template of statements holds beyond
// `obj.attr = value`, which a host's expressions cannot write and Vue's
// handlers do: `row.qty += 1`, `a.x = b.y = v`, `row.a, row.b = pair`,
// `row.a: int = v`. Each written as assignments to one target, in the order
// Python makes them, the object read once, the value once, the operator in
// place on what was read, and on as many lines, so that the rewrite reads and
// writes each of their dots through the host's calls.
function plainWrites($B, tree, def, begin, end) {
    const text = (node) => def.slice(begin(node), end(node));
    // A target's text, between parentheses where it runs over lines.
    const target = (node) => (text(node).includes('\n') ? `(${text(node)})` : text(node));
    const dotted = (node) =>
        node instanceof $B.ast.Attribute || (node instanceof $B.ast.Starred ? dotted(node.value) : (node.elts ?? []).some(dotted));
    // The value between parentheses, where the lines the statement ran over
    // and its parts no longer do are put back (`\0`).
    const value = (node) => `(${text(node)}\0)`;
    let parts = 0;

    // An unpacking's targets each a part of the compiler's, assigned after it
    // in their order.
    const pattern = (node, writes) => {
        if (node instanceof $B.ast.Starred) return `*${pattern(node.value, writes)}`;
        if (node instanceof $B.ast.Tuple || node instanceof $B.ast.List) return `[${node.elts.map((one) => pattern(one, writes)).join(', ')}]`;

        const part = `${PART}${parts++}`;

        writes.push(`${target(node)} = ${part}`);
        return part;
    };

    const fixes = [];
    const met = new WeakSet();
    const walk = (node) => {
        if (!node || typeof node !== 'object' || met.has(node)) return;
        met.add(node);

        let plain;

        if (node instanceof $B.ast.AugAssign && node.target instanceof $B.ast.Attribute) {
            const sign = def.slice(end(node.target), begin(node.value)).match(/(\*\*|\/\/|>>|<<|[-+*\/%@&|^])=/)[0];
            const name = node.target.attr;

            plain = `${OBJECT} = ${target(node.target.value)}; ${VALUE} = ${OBJECT}.${name}; ${VALUE} ${sign} ${value(node.value)}; ${OBJECT}.${name} = ${VALUE}`;
        } else if (node instanceof $B.ast.AnnAssign && node.value && node.target instanceof $B.ast.Attribute) {
            plain = `${target(node.target)} = ${value(node.value)}`;
        } else if (node instanceof $B.ast.Assign && node.targets.some(dotted) && !(node.targets.length === 1 && node.targets[0] instanceof $B.ast.Attribute)) {
            const statements = [`${VALUE} = ${value(node.value)}`];

            for (const one of node.targets) {
                const writes = [];

                if (one instanceof $B.ast.Tuple || one instanceof $B.ast.List) statements.push(`${pattern(one, writes)} = ${VALUE}`, ...writes);
                else statements.push(`${target(one)} = ${VALUE}`);
            }
            plain = statements.join('; ');
        }

        if (plain !== undefined) {
            const missing = text(node).split('\n').length - plain.split('\n').length;

            fixes.push({ from: begin(node), to: end(node), text: plain.replace('\0', '\n'.repeat(Math.max(0, missing))) });
            return;
        }
        for (const key of Object.keys(node)) if (key !== 'parent' && key !== '$parent') walk(node[key]);
    };

    walk(tree);
    return fixes.sort((one, other) => other.from - one.from).reduce((out, one) => out.slice(0, one.from) + one.text + out.slice(one.to), def);
}

// A host's template may give the dot a meaning of its own, a key found as well
// as an attribute: `{pep.title}` reading a dict, where the same text in the
// `<script>` stays plain Python and raises. That is the host's semantics, not
// Python's, so Brycomp applies it to nothing: a host that wants it rewrites its
// template's functions with this before it hands them to `compile()`.
//
// A rule of the template's **text**, so it is applied to the text of the
// functions the template's pass wrote: every attribute read becomes a call to
// the host's `readAttr`, `readAttr(value, "name")`, and the assignment a
// binding writes a call to its `writeAttr`, `writeAttr(value, "name", new)`,
// as every other write through a dot does once made plain (`plainWrites`),
// each under the name the host's runtime gives it (`host.runtime`). A function
// of the script that the template calls keeps plain Python, and a lambda
// written in the template keeps the rule however late it runs. The places come
// from Brython's own parser, in characters, f-string fields included, and no
// line is added, so a function keeps the lines its markup was given.
function templateDots(host, def) {
    const { readAttr, writeAttr, templateText } = host.runtime;
    const $B = engine();
    let tree;

    try {
        tree = $B._PyPegen.run_parser(new $B.Parser(def, '<template>', 'file'));
    } catch {
        // Left as written: the real compile reports it, with the real file name.
        return def;
    }

    const starts = [0];
    for (let i = 0; i < def.length; i++) if (def[i] === '\n') starts.push(i + 1);

    const begin = (node) => starts[node.lineno - 1] + node.col_offset;
    const end = (node) => starts[node.end_lineno - 1] + node.end_col_offset;

    const plain = plainWrites($B, tree, def, begin, end);

    if (plain !== def) return templateDots(host, plain);

    // The first `sign` from a place on, across the spaces, closing parentheses
    // and comments before it, whose own sign, `# profile.name`, is none.
    // Bounded, so a position Brython stopped giving the way this reads it says
    // so rather than walking off the end of the text.
    const after = (from, sign) => {
        let i = from;
        while (i < def.length && def[i] !== sign) {
            if (def[i] === '#') while (i < def.length && def[i] !== '\n') i += 1;
            else i += 1;
        }
        if (i >= def.length) throw new Error(`brycomp — no \`${sign}\` found where a template expression has one`);
        return i;
    };

    // The dot of `value.name`, after the object.
    const dot = (node) => after(end(node.value), '.');

    // `size` orders the insertions made at one place: the widest node's text
    // has to come first, so it is applied last.
    const edits = [];
    const insert = (at, text, node) => edits.push({ from: at, to: at, text, size: end(node) - begin(node) });
    const replace = (from, to, text) => edits.push({ from, to, text, size: 0 });
    // The line breaks of a text replaced, kept inside the call's parentheses,
    // so what follows stays on its line.
    const breaks = (from, to) => '\n'.repeat(def.slice(from, to).split('\n').length - 1);
    // Two texts around a node, outside everything the node holds: the opening
    // one before every opening text at its start, the closing one after every
    // closing text at its end. Half a character wider than the node is what
    // orders them so.
    const wrap = (node, before, after) => {
        const size = end(node) - begin(node) + 0.5;

        edits.push({ from: begin(node), to: begin(node), text: before, size });
        edits.push({ from: end(node), to: end(node), text: after, size: -size });
    };

    // A function whose parameters arrive as functions, named `_late` by the
    // template's pass: each read of one becomes a call, except where a lambda
    // or a comprehension binds the same name for itself.
    // The write half of a binding is handed the value written first, as
    // itself, and only the names after it so. An `async def` as well: read
    // there as written, a parameter stayed the function standing for it.
    const [def0] = tree.body;
    const late =
        (def0 instanceof $B.ast.FunctionDef || def0 instanceof $B.ast.AsyncFunctionDef) &&
        def0.name.startsWith(EXPR_PREFIX) &&
        def0.name.endsWith('_late');
    const lazy = late
        ? new Set(def0.args.args.slice(def0.name.startsWith(`${EXPR_PREFIX}set_`) ? 1 : 0).map((one) => one.arg))
        : new Set();

    // The names a target binds: `x`, `(k, v)`, `*rest`.
    const targets = (target, names = []) => {
        if (target instanceof $B.ast.Name) names.push(target.id);
        if (target instanceof $B.ast.Starred) targets(target.value, names);
        for (const one of target.elts || []) targets(one, names);
        return names;
    };

    const within = (shadowed, names) => new Set([...shadowed, ...names]);

    // The names a walrus binds in the scope of `node`: a comprehension's walrus
    // binds in the scope around it, a nested lambda's in its own.
    const walrused = (node, names = [], met = new WeakSet()) => {
        if (!node || typeof node !== 'object' || met.has(node) || node instanceof $B.ast.Lambda) return names;
        met.add(node);
        if (node instanceof $B.ast.NamedExpr) names.push(node.target.id);
        for (const key of Object.keys(node)) if (key !== 'parent') walrused(node[key], names, met);
        return names;
    };

    const seen = new WeakSet();
    const given = new WeakSet();

    // Python's scopes, not the tree's: every child of a node does not see the
    // same names. A lambda's defaults are read where the lambda is written and
    // its body where it runs, with every parameter bound, and every name a walrus
    // binds there, which is local to the whole body. A comprehension's first
    // iterable is read outside it, and every target is local to all of it, as
    // its scope makes them: bound only for what followed it, a target a lambda
    // in an earlier clause captured was taken for a parameter handed late.
    const scoped = (node, shadowed) => {
        if (node instanceof $B.ast.Lambda) {
            const args = node.args;
            const params = [...args.posonlyargs, ...args.args, ...args.kwonlyargs]
                .concat(args.vararg ? [args.vararg] : [], args.kwarg ? [args.kwarg] : [])
                .map((one) => one.arg);

            for (const one of [...args.defaults, ...args.kw_defaults]) visit(one, shadowed);
            visit(node.body, within(shadowed, [...params, ...walrused(node.body)]));
            return true;
        }

        const comprehension =
            node instanceof $B.ast.ListComp ||
            node instanceof $B.ast.SetComp ||
            node instanceof $B.ast.DictComp ||
            node instanceof $B.ast.GeneratorExp;

        if (!comprehension) return false;

        const inner = within(
            shadowed,
            node.generators.flatMap((one) => targets(one.target))
        );

        // A target reads what it assigns into, `row` in `for row["flag"] in …`,
        // where each step assigns, inside the comprehension: read as every
        // other read there is, a call when it is a parameter handed late. Its
        // own names are stored, never read, and left as they are.
        node.generators.forEach((one, index) => {
            visit(one.iter, index === 0 ? shadowed : inner);
            visit(one.target, inner);
            for (const test of one.ifs) visit(test, inner);
        });

        for (const key of ['elt', 'key', 'value']) if (node[key]) visit(node[key], inner);
        return true;
    };

    const visit = (node, shadowed = new Set()) => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);

        if (scoped(node, shadowed)) return;

        if (node instanceof $B.ast.Name && node.ctx instanceof $B.ast.Load && lazy.has(node.id) && !shadowed.has(node.id)) {
            insert(end(node), '()', node);
        }

        // A walrus that binds one of those names binds the parameter itself,
        // in a comprehension and in a lambda's default as much as here, and
        // every read of it is a call. So it stores a function that answers its
        // value, and gives the value: `(name := (lambda value: lambda:
        // value)(new))()`, which a read after it calls as one before it calls
        // the template's.
        if (node instanceof $B.ast.NamedExpr && lazy.has(node.target.id) && !shadowed.has(node.target.id)) {
            wrap(node, '(', ')()');
            wrap(node.value, '(lambda value: lambda: value)(', ')');
        }

        const [target] = node instanceof $B.ast.Assign ? node.targets : [];

        if (node instanceof $B.ast.Assign && node.targets.length === 1 && target instanceof $B.ast.Attribute) {
            // The target may stand between parentheses, `(row.label) = new`:
            // the call opens before them and they close around the object.
            // The value is one argument, all that stands after the `=`, which
            // may open a parenthesis of its own, `(value)`, or be a tuple,
            // `value, 1`.
            //
            // And evaluated first, as Python evaluates `=`'s: handed to a
            // lambda whose body writes, `(lambda given: writeAttr(row,
            // "label", given))((new))`. An argument after the object,
            // `target().label = answer()` called `target` first.
            const equals = after(end(target), '=');
            const closers = def.slice(end(target), equals).replace(/#.*/g, '').replace(/\s/g, '');
            let value = equals + 1;
            while (def[value] === ' ' || def[value] === '\t') value += 1;
            wrap(node, `(lambda ${GIVEN}: ${writeAttr}(`, '))');
            replace(dot(target), value, `${closers}, ${JSON.stringify(target.attr)}, ${GIVEN}))(${breaks(dot(target), value)}(`);
            visit(target.value, shadowed);
            visit(node.value, shadowed);
            return;
        }

        if (node instanceof $B.ast.Attribute && node.ctx instanceof $B.ast.Load) {
            insert(begin(node), `${readAttr}(`, node);
            replace(dot(node), end(node), `, ${JSON.stringify(node.attr)}${breaks(dot(node), end(node))})`);
        }

        // A debug field, `{row.name=}`, prints the text of its expression, and
        // that text is about to be rewritten: the label goes ahead as a field
        // of its own, and the `=` becomes the `!r` it stands for when nothing
        // else follows. The parser hands the label over as a constant
        // starting just inside the field's brace and ending past the `=` and
        // the spaces after it, the parentheses around the expression included,
        // `{(row.name)=}`, which the expression's own node leaves out. Its text
        // is read off the source at those places: the engine keeps a string
        // constant's value escaped for JavaScript, `\'` for `'`.
        if (node instanceof $B.ast.JoinedStr) {
            node.values.forEach((label, at) => {
                const field = node.values[at + 1];

                if (!(label instanceof $B.ast.Constant && field instanceof $B.ast.FormattedValue)) return;
                if (begin(label) !== begin(field) + 1) return;

                const text = def.slice(begin(label), end(label));
                const sign = begin(label) + text.trimEnd().length - 1;

                insert(begin(field), `{${JSON.stringify(text)}}`, field);
                replace(sign, end(label), def[end(label)] === '}' ? '!r' : '');
            });
        }

        // A t-string's `Template` keeps the text it was written with, which
        // the rewrite changes: its `strings` and each interpolation's
        // `.expression` showed the call the rewrite wrote,
        // `readAttr(row, "name")`, where Python shows `row.name`. Handed to the
        // host's `templateText` as written, read off the source: each
        // expression, all that stands between the brace and what ends it, an
        // `=`, a `!`, a `:` or the closing brace, its spaces and parentheses
        // included, as Python keeps it; and a debug field's label, as an
        // f-string's, whose `=` becomes the `!r` it stands for when nothing
        // else follows. A host with no `templateText` keeps the text rewritten.
        // One the host's own pass already handed over as written, a walrus's
        // field rewritten, is left in that call (`given`).
        if (node instanceof $B.ast.Call && node.func instanceof $B.ast.Name && node.func.id === templateText && node.args[0] instanceof $B.ast.TemplateStr) {
            given.add(node.args[0]);
        }

        // Where the parser placed it. An engine without Brython's
        // `fstring-triple-quote-start` and `fstring-next-line-column` places a
        // string between triple quotes, or a field on a line after its first,
        // past where it stands, and wrapped there, it no longer compiled: left
        // as it was written.
        const placed = (one) =>
            /^[A-Za-z]+['"]/.test(def.slice(begin(one))) && one.values.every((field) => !(field instanceof $B.ast.Interpolation) || def[begin(field)] === '{');

        if (node instanceof $B.ast.TemplateStr && templateText !== undefined && !given.has(node) && node.values.some((one) => one instanceof $B.ast.Interpolation) && placed(node)) {
            const expressions = [];
            const labels = [];

            // The `=` is read off the source, where the expression ends: the
            // parser joins a debug field's label to the text before it,
            // `t"x: {row.name=}"`, in one constant placed nowhere.
            node.values.forEach((field) => {
                if (!(field instanceof $B.ast.Interpolation)) return;

                let close = end(field.value);

                while (close < def.length && !'=!:}'.includes(def[close])) close += 1;
                expressions.push(def.slice(begin(field) + 1, close));

                if (def[close] !== '=') {
                    labels.push('');
                    return;
                }

                let after = close + 1;

                while (/\s/.test(def[after] ?? '')) after += 1;
                labels.push(def.slice(begin(field) + 1, after));
                replace(close, after, def[after] === '}' ? '!r' : '');
            });

            wrap(node, `${templateText}(`, `, ${JSON.stringify(expressions)}, ${JSON.stringify(labels)})`);
        }

        for (const key of Object.keys(node)) if (key !== 'parent') visit(node[key], shadowed);
    };

    visit(tree);

    // The helpers are called by name where the rewrite calls them, and a name
    // the function binds of that spelling takes the call: a parameter, a
    // lambda's or a comprehension's, a walrus, a `def`, an import. Refused,
    // as the host's helper cannot be reached from there.
    if (edits.length) {
        const helpers = new Set([readAttr, writeAttr, templateText].filter((one) => one !== undefined));
        const walked = new Set();
        const binder = (node) => {
            if (!node || typeof node !== 'object' || walked.has(node)) return undefined;
            walked.add(node);

            const found = (node instanceof $B.ast.arg ? [node.arg] : bindsHere(node)).find((one) => helpers.has(one));
            if (found !== undefined) return found;

            for (const key of Object.keys(node)) {
                const deeper = key === 'parent' || key === '$parent' ? undefined : binder(node[key]);
                if (deeper !== undefined) return deeper;
            }
            return undefined;
        };
        const taken = binder(tree);

        if (taken !== undefined) {
            throw refuse(
                `${host.name} — \`${taken}\` is the helper a template expression calls to read or write an ` +
                    `attribute, and a name the expression binds of that spelling takes the call: choose another`
            );
        }
    }

    edits.sort((one, other) => other.from - one.from || one.size - other.size);

    return edits.reduce((text, one) => text.slice(0, one.from) + one.text + text.slice(one.to), def);
}

// The Python of a component: `text` is what the author wrote in its script;
// `defs` are the hidden functions the template's pass produced, one per
// template expression, and `lines` and `columns` where in the file the markup
// of each stands. They are joined here rather than by the caller because the
// join carries an invariant, and an invariant living in a comment at each call
// site is one that will be got wrong.
//
// The invariant is the indentation. A `<script>` body sits inside markup and
// every example of a framework indents it one level; in JavaScript that is
// whitespace, in Python it is syntax, and the block raises `IndentationError`,
// pointing, in Brython, at the line *after* the last one, which tells the
// author nothing.
//
// `$B.unindent` is Brython's own, the one it already runs on every `<script
// type="text/python">`, so the two tags behave alike and there is no second
// copy of the rule to keep in agreement. It is private upstream, so the engine
// Bryvend ships exposes it in one token. Its rule is `textwrap.dedent`'s with
// a conservative bail (one non-blank line already at column zero and the source
// comes back untouched), and blank lines are kept, so the line count never
// moves and the source map, the tracebacks and `$B.set_lineno` are unaffected.
//
// It has to happen **before** the defs are appended: those are generated at
// column zero and would trip that bail on every component. Holding that order
// is why this lives here and not at the call sites.
//
// A `.py` gets neither half: a file is not an embedded block, so an indented
// one is a mistake rather than a convenience, and a module has no template to
// collect from.
//
// The functions are joined as the host hands them: what its template's text
// means, a dot that reads a key among it, is the host's to have written.
//
// `ranges` says where each template function lands in the Python source, as
// `[from, to, line, column, text]`, with the file line and column of the
// markup it stands for and the expression as written: an error raised inside
// one, or inside a lambda it made, is reported there rather than at a line of
// the script that happens to share its number. `templateLine` is where the
// first one starts.
function componentSource(text, defs, lines = [], columns = [], texts = []) {
    const body = engine().unindent(text);
    const ranges = [];
    let templateLine;
    let from = body.split('\n').length + 1;

    if (defs.length) templateLine = from;

    defs.forEach((def, index) => {
        const to = from + def.split('\n').length - 1;

        if (lines[index] !== undefined) ranges.push([from, to, lines[index], columns[index], texts[index]]);

        from = to + 2;
    });

    return { src: defs.length ? `${body}\n${defs.join('\n\n')}\n` : body, ranges, templateLine };
}

export { EXPR_PREFIX, templateDots, componentSource };
