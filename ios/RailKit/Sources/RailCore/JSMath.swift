import Foundation

// V8's arithmetic, where it differs from the platform's.
//
// This exists because of a measurement, not a suspicion. Over 5,000 real
// coordinate pairs drawn from the N02 network:
//
//     Darwin cos          209 / 5000 disagree with V8, worst 1 ULP
//     Darwin hypot      1,819 / 5000 disagree with V8, worst 2 ULP
//     sqrt(x*x + y*y)   1,827 / 5000 disagree with V8, worst 3 ULP
//
// So `hypot` — the obvious choice, and the one this repository's porting
// recipe used to recommend — is wrong on more than a third of real inputs.
// V8 does not call libm for either function: `Math.hypot` is max-scaling plus
// Kahan summation, and `Math.cos` is V8's own fdlibm port in base/ieee754.cc.
//
// Whether that matters depends on what the answer is used for. A distance
// compared against a threshold can absorb a last-bit difference; a distance
// *summed* over 377,620 edges cannot, and mileage totals are exactly that.
// With these two, every kilometre total in port-fixtures/stats.json matches
// bit for bit, including Japan's 27,263.169326083345 km — no ULP ceiling
// anywhere.
//
// Ported by the mileage-statistics port and lifted out of it so that later
// ports reuse it rather than each rediscovering the same divergence.

/// The two library functions `AppCore.equirectKm` is built out of, in
/// V8's spelling rather than the platform's.
///
/// This is not pedantry, it is the difference between a total that matches
/// and one that does not. Measured over 5,000 real N02 vertex pairs:
/// Darwin's `cos` disagrees with V8's on 209 of them (1 ULP each) and
/// Darwin's `hypot` disagrees with V8's on 1,819 (up to 2 ULP), and the
/// Japanese total is a sum of 377,620 of these. `PORTING.md`'s table
/// suggests Swift's `hypot` for `Math.hypot`; that turns out to be wrong,
/// because V8 does not call the platform at all for either function.
public enum JSMath {

    /// `Math.hypot`, which V8 implements itself: scale by the largest
    /// magnitude, Kahan-sum the squares, then `sqrt(sum) * max`. That is a
    /// different rounding path from `hypot(3)`, and the two agree only
    /// about two thirds of the time on real coordinates.
    public static func hypot(_ x: Double, _ y: Double) -> Double {
        if x.isInfinite || y.isInfinite { return .infinity }
        if x.isNaN || y.isNaN { return .nan }
        let ax = abs(x)
        let ay = abs(y)
        let scale = Swift.max(ax, ay)
        if scale == 0 { return 0 }
        var sum = 0.0
        var compensation = 0.0
        for value in [ax, ay] {
            let n = value / scale
            let summand = n * n - compensation
            let preliminary = sum + summand
            compensation = (preliminary - sum) - summand
            sum = preliminary
        }
        return sum.squareRoot() * scale
    }

    /// `Math.cos`, which V8 answers from its own fdlibm port
    /// (`base/ieee754.cc`) so that a JavaScript program gives the same
    /// answer on every platform. Darwin's libm is a different, also
    /// correct, implementation — and 1 ULP apart on ~4 % of inputs.
    ///
    /// Only the two argument-reduction branches this app can reach are
    /// implemented: `equirectKm` calls this with a WGS84 latitude in
    /// radians, so |x| ≤ π/2 and the "medium size" reduction (a single
    /// subtraction of π/2, `n = ±1`) always suffices. Anything larger
    /// would need fdlibm's full `__kernel_rem_pio2` with its two-over-π
    /// table, so it traps rather than silently falling back to a function
    /// that answers differently.
    public static func cos(_ x: Double) -> Double {
        let ix = highWord(x) & 0x7fff_ffff
        if ix <= 0x3fe9_21fb { return kernelCos(x, 0) }  // |x| ~< π/4
        if ix >= 0x7ff0_0000 { return x - x }  // cos(Inf or NaN) is NaN
        let (n, y0, y1) = remPio2(x)
        switch n & 3 {
        case 0: return kernelCos(y0, y1)
        case 1: return -kernelSin(y0, y1)
        case 2: return -kernelCos(y0, y1)
        default: return kernelSin(y0, y1)
        }
    }

    @inline(__always) private static func highWord(_ x: Double) -> Int32 {
        Int32(bitPattern: UInt32(truncatingIfNeeded: x.bitPattern >> 32))
    }

    @inline(__always) private static func fromHighWord(_ hi: UInt32) -> Double {
        Double(bitPattern: UInt64(hi) << 32)
    }

    // fdlibm __kernel_cos, |x| <= π/4.
    private static func kernelCos(_ x: Double, _ y: Double) -> Double {
        let C1 = 4.16666666666666019037e-02
        let C2 = -1.38888888888741095749e-03
        let C3 = 2.48015872894767294178e-05
        let C4 = -2.75573143513906633035e-07
        let C5 = 2.08757232129817482790e-09
        let C6 = -1.13596475577881948265e-11

        let ix = highWord(x) & 0x7fff_ffff
        if ix < 0x3e40_0000, Int32(x) == 0 { return 1.0 }  // |x| < 2^-27
        let z = x * x
        let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
        if ix < 0x3FD3_3333 {  // |x| < 0.3
            return 1.0 - (0.5 * z - (z * r - x * y))
        }
        // Above 0.3 the naive form loses the leading bits of 1 - z/2, so
        // fdlibm splits off a quarter-magnitude constant first.
        let qx = ix > 0x3fe9_0000 ? 0.28125 : fromHighWord(UInt32(bitPattern: ix - 0x0020_0000))
        let iz = 0.5 * z - qx
        return (1.0 - qx) - (iz - (z * r - x * y))
    }

    // fdlibm __kernel_sin with iy = 1 (the reduced-argument tail matters).
    private static func kernelSin(_ x: Double, _ y: Double) -> Double {
        let S1 = -1.66666666666666324348e-01
        let S2 = 8.33333333332248946124e-03
        let S3 = -1.98412698298579493134e-04
        let S4 = 2.75573137070700676789e-06
        let S5 = -2.50507602534068634195e-08
        let S6 = 1.58969099521155010221e-10

        let ix = highWord(x) & 0x7fff_ffff
        if ix < 0x3e40_0000, Int32(x) == 0 { return x }
        let z = x * x
        let v = z * x
        let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
        return x - ((z * (0.5 * y - v * r) - y) - v * S1)
    }

    /// fdlibm `__ieee754_rem_pio2`, medium-size branch only (|x| < 3π/4).
    private static func remPio2(_ x: Double) -> (n: Int, y0: Double, y1: Double) {
        let pio2_1 = 1.57079632673412561417e+00  // π/2, high 33 bits
        let pio2_1t = 6.07710050650619224932e-11  // …and the rest
        let pio2_2 = 6.07710050630396597660e-11
        let pio2_2t = 2.02226624879595063154e-21

        let hx = highWord(x)
        let ix = hx & 0x7fff_ffff
        if ix <= 0x3fe9_21fb { return (0, x, 0) }
        precondition(
            ix < 0x4002_d97c,
            """
            JSMath.cos was called with |x| >= 3π/4. equirectKm \
            only ever passes a WGS84 latitude in radians, so this means a \
            coordinate outside ±90°; fdlibm's full argument reduction is \
            not ported, and substituting the platform's cos would silently \
            change the answer.
            """
        )
        if hx > 0 {
            var z = x - pio2_1
            if ix != 0x3ff9_21fb {  // 33+53 bit π is good enough
                let y0 = z - pio2_1t
                return (1, y0, (z - y0) - pio2_1t)
            }
            z -= pio2_2  // near π/2, use 33+33+53 bit π
            let y0 = z - pio2_2t
            return (1, y0, (z - y0) - pio2_2t)
        }
        var z = x + pio2_1
        if ix != 0x3ff9_21fb {
            let y0 = z + pio2_1t
            return (-1, y0, (z - y0) + pio2_1t)
        }
        z += pio2_2
        let y0 = z + pio2_2t
        return (-1, y0, (z - y0) + pio2_2t)
    }
}
