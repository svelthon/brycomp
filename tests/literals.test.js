// @vitest-environment node
//
// Where the fields of an f-string or a t-string lie, as `atomic` tells them:
// the code of a literal, and nothing of its text.
import { test, expect } from 'vitest';
import * as brycomp from '../src/brycomp.js';

const fields = (source) => {
    const found = [];
    const length = brycomp.atomic(source, source.search(/['"]/), (from, to) => found.push(source.slice(from, to)));

    return { found, length };
};

// A named escape is one character of the text: its braces opened a field, and
// `GREEK SMALL LETTER PI` was taken for code.
test.for([
    ['t"left \\N{GREEK SMALL LETTER PI} {caption=} right"', ['caption=']],
    ['f"\\N{BULLET}\\N{BULLET} {x}"', ['x']],
    ['f"{x:\\N{BULLET}}"', ['x']],
    // Raw, the backslash is text and the braces a field's.
    ['rf"\\N{x}"', ['x']],
    ['tr"\\N{x}"', ['x']],
    // A doubled backslash is one, and the `N` after it text.
    ['f"\\\\N{x}"', ['x']]
])('%s', ([source, expected]) => {
    expect(fields(source)).toEqual({ found: expected, length: source.length - source.search(/['"]/) });
});
