# How a function gets ported

The Swift app re-implements the web app's pure logic. That is 20 files and
about 14,000 lines of JavaScript, so it happens one function at a time, often
several at once, and it only works if every port is checked the same way.

This is the recipe. It is written so that a person or an agent can follow it
without further instruction, and so that several can follow it simultaneously
without colliding.

## The unit of work

**One function, three new files, no edits to anything else.**

    app/scripts/build/port-fixtures/<name>.mjs           the fixture
    ios/RailKit/Sources/RailCore/<Name>.swift            the port
    ios/RailKit/Tests/RailCoreTests/<Name>ParityTests.swift   the check

Three new files and no shared edits is not a style preference; it is what lets
work run in parallel. Every shared file is a file two people have to merge, so
the two places that used to be shared were removed: the fixture generator now
auto-discovers `port-fixtures/*.mjs`, and the fixture loader moved out of
`FixtureParityTests` into `PortFixtures` so each port brings its own test file.

## The rule everything rests on

`RailCore` imports Foundation and nothing else — no MapKit, SwiftUI, UIKit or
CoreLocation. With no platform underneath it, the same functions can be run
against the same inputs as the JavaScript, which is the only reason any of
this is checkable. `verify.sh` fails the build if that ever stops being true,
because a stray `import MapKit` compiles perfectly well and quietly ends it.

## Writing the fixture

```js
export const name = "<name>.json";
export function build({ RailNetwork, AppCore, js, railPackage, APP_DIR }) {
  return { describes: "...", contract: "...", cases: [ /* ... */ ] };
}
```

Then `cd app && node scripts/build/build-port-fixtures.mjs` (plain node — the
generator needs no installed dependencies).

Four rules decide whether a fixture is worth having:

**Call the real JavaScript.** Never re-implement the function inside the
fixture module. A fixture generated from a copy proves only that the copy and
the port agree, which is not the question. If the function is not exported,
evaluate the classic script the way `loadFrontendScope` does rather than
pasting its body.

**The expected value is whatever the JavaScript returns today.** Not a second
opinion about what it should be. If the JavaScript is wrong, the fixture is
wrong the same way and the port reproduces the bug — which is correct, because
a port that quietly fixes something is a port whose disagreements can no longer
be read. Fix the JavaScript first, regenerate, and the diff is the list of
answers that moved.

**Use real inputs.** The shipped packages carry the real distribution and its
real edge cases. Invented coordinates are tidy in exactly the ways production
data is not.

**Add cases designed to fail.** A fixture that only contains ordinary inputs
lets a naive port pass and then break in the field. The two disagreements this
port has caught so far were both found by adversarial cases, not by volume.

## Writing the Swift

Reproduce the behaviour, including behaviour that looks accidental. Read the
JavaScript's comments before writing any Swift — this codebase records *why* in
them, and the reason usually belongs in the Swift too. Explain why, not what.

The differences that have actually bitten, all of which compile silently:

| JavaScript | Swift | Use |
| --- | --- | --- |
| `String(139)` → `"139"` | `String(139.0)` → `"139.0"` | `JSNumber.string` |
| `Math.round` ties toward +∞ | `.rounded()` ties away from zero | `JSNumber.round` |
| strings compare by UTF-16 code unit | `String` compares by canonical equivalence | `JSNumber.stringLessOrEqual`, or `String.utf16` |
| `Math.hypot` | `sqrt(x*x + y*y)` differs in the last bit | `hypot` |
| `x ** 2` | `pow(x, 2)` may differ in the last bit | measure it |
| months are 0-based | `DateComponents.month` is 1-based | pin `Calendar`/`TimeZone` |

## Writing the test

Swift Testing (`@Test`, `#expect`), fixtures via `PortFixtures.decode(...)`,
packages via `PortFixtures.package(country:)`.

Compare **bit for bit** — `Double.bitPattern`, and vertex counts as well as
vertices. Where exact equality proves impossible, do not reach for a relative
epsilon: state a **measured ULP ceiling** and explain what you measured, the
way `FixtureParityTests.distances` does for haversine. A relative epsilon loose
enough to absorb a library difference is also loose enough to absorb a wrong
constant; a ULP ceiling is not.

## The gate

```sh
cd ios && ./verify.sh          # everything
cd ios && ./verify.sh --core   # RailCore + parity tests, the porting loop
```

`SCRATCH=/tmp/port-x ./verify.sh --core` gives a worker its own build
directory, which is what lets several run at once. (It also has to live off the
repository: `~/Documents` is iCloud-backed, and the file provider re-adds
`com.apple.FinderInfo` to build products, which `codesign` then refuses.)

The order is deliberate. The JavaScript suite and lint run **first**, because
the web app is the reference implementation — if its behaviour moved, every
fixture is stale and every Swift result checked against one is meaningless.
Then `--check` on the fixtures, so a fixture can only change deliberately.
Then RailCore, its parity tests, and the platform-import rule. Then the app.

## Running several at once

Give each worker its own git worktree. They write disjoint files, so nothing
needs merging — but in one shared tree a half-written file from one port fails
everyone else's `swift test`, and the reports become noise.

Ask for a report that says what disagreed and why. "It passes" is the least
interesting thing a port can tell you; the disagreements are the findings.
