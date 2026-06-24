/*
 * Leaflet.PolylineOffset (bbecquet/Leaflet.PolylineOffset, MIT)
 * Vendored locally so the offset feature works offline / with local tiles.
 * Adds an `offset` option (in layer pixels) to L.Polyline; the offset is
 * applied AFTER projection to layer points, so it works with both the SVG
 * and the Canvas renderer and stays a constant pixel distance across zoom.
 */
(function (factory, window) {
    if (typeof define === 'function' && define.amd) {
        define(['leaflet'], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory(require('leaflet'));
    }
    if (typeof window !== 'undefined' && window.L) {
        window.L.PolylineOffset = factory(L);
    }
}(function (L) {

function forEachPair(list, callback) {
    if (!list || list.length < 1) { return; }
    for (var i = 1, l = list.length; i < l; i++) {
        callback(list[i-1], list[i]);
    }
}

function lineEquation(pt1, pt2) {
    if (pt1.x === pt2.x) {
        return pt1.y === pt2.y ? null : { x: pt1.x };
    }
    var a = (pt2.y - pt1.y) / (pt2.x - pt1.x);
    return { a: a, b: pt1.y - a * pt1.x };
}

function intersection(l1a, l1b, l2a, l2b) {
    var line1 = lineEquation(l1a, l1b);
    var line2 = lineEquation(l2a, l2b);
    if (line1 === null || line2 === null) { return null; }
    if (line1.hasOwnProperty('x')) {
        return line2.hasOwnProperty('x')
            ? null
            : { x: line1.x, y: line2.a * line1.x + line2.b };
    }
    if (line2.hasOwnProperty('x')) {
        return { x: line2.x, y: line1.a * line2.x + line1.b };
    }
    if (line1.a === line2.a) { return null; }
    var x = (line2.b - line1.b) / (line1.a - line2.a);
    return { x: x, y: line1.a * x + line1.b };
}

function translatePoint(pt, dist, heading) {
    return {
        x: pt.x + dist * Math.cos(heading),
        y: pt.y + dist * Math.sin(heading)
    };
}

var PolylineOffset = {
    offsetPointLine: function(points, distance) {
        var offsetSegments = [];
        forEachPair(points, L.bind(function(a, b) {
            if (a.x === b.x && a.y === b.y) { return; }
            var segmentAngle = Math.atan2(a.y - b.y, a.x - b.x);
            var offsetAngle = segmentAngle - Math.PI/2;
            offsetSegments.push({
                offsetAngle: offsetAngle,
                original: [a, b],
                offset: [
                    translatePoint(a, distance, offsetAngle),
                    translatePoint(b, distance, offsetAngle)
                ]
            });
        }, this));
        return offsetSegments;
    },

    offsetPoints: function(pts, options) {
        var offsetSegments = this.offsetPointLine(L.LineUtil.simplify(pts, options.smoothFactor), options.offset);
        return this.joinLineSegments(offsetSegments, options.offset);
    },

    joinSegments: function(s1, s2, offset) {
        return this.circularArc(s1, s2, offset)
            .filter(function(x) { return x; });
    },

    joinLineSegments: function(segments, offset) {
        var joinedPoints = [];
        var first = segments[0];
        var last = segments[segments.length - 1];
        if (first && last) {
            joinedPoints.push(first.offset[0]);
            forEachPair(segments, L.bind(function(s1, s2) {
                joinedPoints = joinedPoints.concat(this.joinSegments(s1, s2, offset));
            }, this));
            joinedPoints.push(last.offset[1]);
        }
        return joinedPoints;
    },

    segmentAsVector: function(s) {
        return { x: s[1].x - s[0].x, y: s[1].y - s[0].y };
    },

    getSignedAngle: function(s1, s2) {
        var a = this.segmentAsVector(s1);
        var b = this.segmentAsVector(s2);
        return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    },

    circularArc: function(s1, s2, distance) {
        if (s1.offsetAngle === s2.offsetAngle) {
            return [s1.offset[1]];
        }
        var signedAngle = this.getSignedAngle(s1.offset, s2.offset);
        if ((signedAngle * distance > 0) &&
            (signedAngle * this.getSignedAngle(s1.offset, [s1.offset[0], s2.offset[1]]) > 0)) {
            return [intersection(s1.offset[0], s1.offset[1], s2.offset[0], s2.offset[1])];
        }
        var points = [];
        var center = s1.original[1];
        var rightOffset = distance > 0;
        var startAngle = rightOffset ? s2.offsetAngle : s1.offsetAngle;
        var endAngle = rightOffset ? s1.offsetAngle : s2.offsetAngle;
        if (endAngle < startAngle) { endAngle += Math.PI * 2; }
        var step = Math.PI / 8;
        for (var alpha = startAngle; alpha < endAngle; alpha += step) {
            points.push(translatePoint(center, distance, alpha));
        }
        points.push(translatePoint(center, distance, endAngle));
        return rightOffset ? points.reverse() : points;
    }
};

L.Polyline.include({
    _projectLatlngs: function (latlngs, result, projectedBounds) {
        var isFlat = latlngs.length > 0 && latlngs[0] instanceof L.LatLng;
        if (isFlat) {
            var ring = latlngs.map(L.bind(function(ll) {
                var point = this._map.latLngToLayerPoint(ll);
                if (projectedBounds) { projectedBounds.extend(point); }
                return point;
            }, this));
            if (this.options.offset) {
                ring = L.PolylineOffset.offsetPoints(ring, this.options);
            }
            result.push(ring.map(function (xy) {
                return L.point(xy.x, xy.y);
            }));
        } else {
            latlngs.forEach(L.bind(function(ll) {
                this._projectLatlngs(ll, result, projectedBounds);
            }, this));
        }
    }
});

L.Polyline.include({
    setOffset: function(offset) {
        this.options.offset = offset;
        this.redraw();
        return this;
    }
});

return PolylineOffset;

}, window));
