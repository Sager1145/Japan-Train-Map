// Deterministic render-model snapshot of a loaded rail network, shared by
// test/rail-loader-parity.test.mjs and test/rail-network.test.js so a
// regeneration of public/rail/jp-2025.json needs exactly ONE hash update.
// The snapshot covers everything the map render/popup path reads; hash it
// with sha256(JSON.stringify(...)). Geometry grooming uses Math.hypot/cos and
// friends, whose final few binary digits can differ between the libm shipped
// by macOS and Linux. Those differences are many orders of magnitude below a
// rendered pixel, but an exact JSON hash would still turn them into unrelated
// digests. Canonicalize non-integer numbers to 10 decimal places (~0.01 mm for
// longitude/latitude) so the characterization remains visually exact while
// being deterministic on both local machines and GitHub's Linux runners.

// 2026-08-15 rebuild — 913 / 10189 / 649 / 9039, from 888 / 10161 / 607 / 9046.
//
// The drawn set grew because each railway's separate alignments became their
// own strokes: a rejoining route, a physically detached half, a branch off a
// tree. Platforms rose with it (a junction shared by two strokes is a row on
// each) while station GROUPS fell by seven, since four lines with no passenger
// adjacency at all are no longer drawn.
//
// This hash is the single point that pins the whole render model. Update it
// only alongside the package it characterises, never to make a suite pass.
//
// 2026-08-18 batch 5 — 914 / 10222 / 660 / 9039: four audit pseudo-edges
// deleted (大井町—西大井 蛇窪 V; the three 成田-skipping edges of the 成田線
// K4 clique), so the 東海道線(JR東日本) family re-settled around its real
// 品川–鶴見 ring and 成田線 folded to three strokes sharing 成田 (成田線-4
// gone), plus three doubling-back lead-ins trimmed at 中野, 秋田 and 幡ヶ谷.
// 2026-08-18 batch 6 — 915 / 10222 / 658 / 9039: 長崎線 and 東海道線(JR東日本)
// take their official shapes. 長崎線's trunk runs 鳥栖–長崎 via the 市布新線
// (the shield generalisation stops the skip-edge test cutting 現川–浦上 at its
// own junction) and the 旧線 via 長与 is a rejoining branch 喜々津–浦上, so
// 長崎線-3 folds in. 東海道線's trunk runs 東京–熱海 via 品川・川崎・横浜, the
// 品鶴線 is its own 品川–鶴見 stroke (whose 新幹線-corridor lane pairing
// re-solved, 2→5 features) and the 相鉄連絡線 renumbers -4 → -3.
// 2026-08-18 batch 7 — 916 / 10223 / 658 / 9039: 京王新線 becomes its own
// line (新線新宿–初台–幡ヶ谷–笹塚, carved from the「京王線」N02 key), 京王線
// runs 新宿–笹塚 direct and the 初台–幡ヶ谷 orphan 京王線-2 folds away, so
// the line count holds still while the 新宿–笹塚 corridor gains the 新線's
// lane feature and 新宿 gains its 新線 platform row.
// 2026-08-18 batch 8 — 916 / 10223 / 658 / 9039, all counts still: 東京駅
// takes its per-line platform dots (R13). 東北新幹線 leaves the 東海道新幹線
// platforms N02 copied it onto and stands on its own 20-23 group 48 m west
// (registered geometry patch, OSM centreline); 東北線-2 and 東海道線 share
// one surface dot; 総武線's rapid
// takes its own 馬喰町 tunnel with 両国 handed back to the 御茶ノ水 local
// stroke (one station row each way, so the totals hold).
// 2026-08-18 batch 9 — 916 / 10225 / 658 / 9039: the shared conventional dot
// moves to the middle platform feature; the 総武快速 stroke continues from its
// underground 東京 dot southwest along OSM's 東京トンネル through underground
// 新橋・品川 to 西大井. Its existing 品鶴 display part becomes blue 総武線-3,
// adding the two intermediate platform rows without adding a line or feature.
// 2026-08-18 batch 10 — 918 / 10225 / 658 / 9039: both Shinkansen, the shared
// 東北線–東海道線 surface stroke and the north half of the 総武 underground
// stroke follow their selected OSM physical rails through Tokyo's adjacent
// intervals. Two display features are added where the registered corridors now
// enter/leave the existing screen-space lane stretches at their real junctions.
// 2026-08-18 batch 11 — 916 / 10225 / 658 / 9039: Tokyo's 東北線 and
// 東海道線 are welded at track 10's exact OSM node and registered as one
// Ueno–Tokyo through railway. Both halves now take the same -0.5 render lane,
// removing the two lane-transition features that batch 10 introduced and
// making the station one smooth Sapporo-style junction rather than two dots.
// 2026-08-18 batch 12 — 910 / 10223 / 657 / 9039: the whole-country
// multi-line-station audit removes the stale 函館線-4 鹿部–大沼 duplicate that
// the current inventory no longer emits, records railwayIdentity on every
// sibling family, and derives junction-aware lane ramps. Two-stroke
// continuations carry one screen-side lane through their shared platform;
// true branches return to lane 0 at the physical junction, so no offset tears
// one railway into two visible station points.
// 2026-08-18 batch 13 — 918 / 10223 / 657 / 9039: propagate Tokyo's explicit
// Ueno–Tokyo identity from the registered 東北線-2 / 東海道線 junction to every
// sibling display stroke in both canonical families. This removes the false
// independent-railway split around 日暮里; the eight extra render pieces are
// the resulting lane-profile boundaries against genuinely separate railways.
// 2026-08-18 close-out — 918 / 10223 / 657 / 9039, counts still: the standing
// doubling-back repairs re-applied after the day's promotes. 中央線 中野→東中野
// (2.75 → 1.76 km) and 奥羽線 秋田→四ツ小屋 (7.26 → 6.37 km) had shipped
// untrimmed when their staging strokes were promoted wholesale; the CASES
// script re-cut both against their official mileages and remapped 128
// structure rows, exactly as the batch-5 landing first did.
// 2026-08-18 batch 14 — 918 / 10223 / 657 / 9039, counts still: the builder's
// re-anchoring pass now also fires when a built interval runs 30 %+300 m past
// its audited distance, so a station standing on a dead-end platform section
// is re-seated on the through platform instead of drawing an out-and-back
// fold. Exactly six parts nationwide are in that band and all six re-anchor
// clean in staging; five are promoted: 東海道線 (JR東海) 尾頭橋→名古屋
// 3.60→2.85 km (the 180° fold at 名古屋), 中央線 中野→東中野 2.75→1.76 built
// clean at source (the standing trim case becomes a guard) with 新宿→代々木
// 1.01→0.73 riding along, 南海本線 岸里玉出→粉浜 1.84→1.24, 山陽線
// 天神川→広島 and 横川→西広島, and 阪和線-2 東羽衣→鳳. Every moved dot lands
// exactly on a sibling N02 platform feature of its own line. The sixth,
// 東北線-3 西日暮里→日暮里 1.17→0.63, is deliberately NOT promoted, pending
// the batch-9 review.
//
// 2026-08-18: screen-space lane offsets were removed from the render, so a
// line is one feature on its own surveyed geometry again instead of one
// feature per lane it took (jp 918 → 657 segment features). Every coordinate
// is unchanged; what the hash moved for is the feature split, and nothing
// else.
//
// 2026-08-19: batch 1 of the multi-line station audit. Four registered
// platform picks (evidence/station-platform-assignments.json) move six lines'
// dots onto the platform their own trains use, measured against OSM:
// 岸里玉出 高野線 185 m → 1.2 m from a way named 南海電気鉄道高野線, 品川
// 東海道線 32 → 6.9, 西船橋 総武線 24.2 → 11.0, 大阪 東海道線 23.5 → 2.1.
// Every pick selects an EXISTING N02 feature — no official geometry is
// overridden — so what moved is which of several surveyed platforms each
// stroke anchors on.
//
// 2026-08-19 batch 2 — 13 registered station-anchor overrides
// (evidence/station-anchor-overrides.json, generated by
// build-station-anchor-evidence.mjs). Each replaces ONE N02 station feature
// with the surveyed OSM platform its own line serves, leaving RailroadSection
// geometry untouched, and is written only when that platform sits within 25 m
// of a way named for the line. Resolved: 横浜 相鉄本線 130.6→0.2 m,
// 京成高砂 北総線 48.3→9.4, 東武日光 日光線 139.5→…, 福島 飯坂線 94.8→8.6,
// 橿原神宮前 吉野線 →0.3, 糸魚川 大糸線, 宮古 山田線, 伊予立川 予讃線-2,
// 多久 唐津線, 穴内 阿佐線, 土佐昭和 予土線.
// A 14th row (名古屋 西名古屋港線, platform ref 14;15) was REVERTED: applying
// it measured worse, 148.9→195.7 m, because ref 14;15 is a JR island and
// あおなみ線 uses its own — the 25 m gate passed on a naming artifact. It
// waits for route-relation evidence. 広島電鉄 宇品線 was built but NOT
// promoted, because moving 紙屋町西 split the line into a trunk plus a branch;
// that row is reverted too — see the 2026-08-19 宇品線 entry below.
//
// 2026-08-19 品川 revert — batch 1's 東海道線 platform pick is withdrawn. It
// improved the dot (32.0 m to 1.6 m from a way named 東海道本線) but forced
// 高輪ゲートウェイ→品川 to double back: 0.837 km / 12 deg became 1.294 km /
// 169 deg, +695 m over the audited 0.599 km, because the chosen feature sits
// at the north end of the group. Reverted, and the interval is 838 m / 10 deg
// again. Reported by the parallel audit session's isolation build;
// validate-railway-topology missed it because sharp_artificial_turn requires
// BOTH edges at a corner to be >=60 m and these are 70 m and 36 m. A fold scan
// with no edge-length floor over every line this campaign touched finds no
// other new fold: 北赤羽 168, 王子 168, 成東 163 and 東京 90 all predate it.
//
// 2026-08-19 audited junctions — 657 / 10224 / 657 / 9039, from 657 / 10223 /
// 657 / 9039. A junction the audit NAMES now stays on the trunk however few
// neighbours it has outside its branch part, so 山万ユーカリが丘線 stops being
// drawn with a hole in it: the tail runs 公園–地区センター–ユーカリが丘 again.
// 公園 is where the tail meets the residential ring, and while it was peeled
// onto the ring alone the 449 m 公園–地区センター hop belonged to neither
// stroke — the map drew the ring floating clear of the tail. The one new
// platform row is that shared junction. Nothing else moves: a hop between two
// junctions is left to the trunk, so 上越線's 湯檜曽–土合 下り線 and 東海道線's
// 梅田貨物線 stay reported as uncovered corridor instead of being drawn as a
// second copy of the trunk's own cut of the same station pair. The builder
// change also restores 中央線's みどり湖–塩尻 (3.96 km the 辰野支線 stroke does
// not cover), but that line is NOT promoted here: at 塩尻 the trunk and the
// 辰野支線 both terminate and share the first 1.204 km of track vertex for
// vertex, and audit-japan-multiline-stations calls that pair a continuation
// (class A) and demands a tangent under 5° where a fork reads 180°. The rules
// file already says class A is "a continuation rather than a branch" and
// class B is a branch or rejoin station, so the classifier — not the data —
// is what has to settle first.
// 2026-08-19 switchback pseudo-edges — 654 / 10219 / 654 / 9039, from
// 657 / 10224 / 657 / 9039. The station contracted graph carried a direct edge
// across three reversal stations, because N02 joins the two legs at a junction
// a few hundred metres short of the platform and first_station_paths walks
// through it without asking whether a train could make the turn: 室—西大垣 past
// 大垣, 川東—東山代 past 伊万里, 北赤羽—川口 past 赤羽. Each line drew the fold
// instead of the station. With the three edges deleted (see
// evidence/network-corrections-2026-08-13.json, block
// switchback_pseudo_edge_removals_2026_08_19) the trunks run through all three
// stations — 養老線 27 stations / 57.48 km against an official 57.5, 西九州線 57
// / 93.88 against 93.8 — and the three strokes that existed only to carry the
// skipped station stop being produced: 養老線-2, 西九州線-2 and 東北線-7, whose
// 王子–上中里 track is 東北線-6 now. The five station rows are those strokes'
// duplicate copies; every station stayed, on the trunk. Same batch, path_matching
// prefers a route that does not run past its destination platform and fold back,
// which straightened 東北線-3's 西日暮里→日暮里 (696 m fold) — the sixth staging
// fix the 2026-08-18 note above deferred, resolved by path choice rather than by
// re-anchoring, so the lane solver never sees a second pairing.
// 2026-08-19 station approaches at reversals — counts unchanged, GEOMETRY
// changed, which is why this digest moves without a line, station or group
// following it. Two display-layer passes were inventing shape at the stations
// where a branch leaves its trunk and the two legs share the rail between
// platform and switch:
//   * the approach rebuild read that pair joined head-to-tail as "the
//     alignment through the platform". It is a FOLD, and the nearest point on
//     a fold is its apex, so the longitudinal gap up to the platform was read
//     as a sideways displacement and blended across the approach window. 成田
//     measured 205 m and was drawn up to 93 m off its own survey — the 佐原
//     main line swung clear of the basemap track that 成田線-3, built from the
//     very same coordinates, still sat on, which is what the reader saw as two
//     parallel teal strokes with a spindle between them.
//   * the retrace split cut the trunk at the switch and welded it onto the
//     returning leg, a corner of 135° at 成田, 133° at 会津若松, 126° at 養老線
//     and 118° at 西九州線 — angles the topology audit itself calls impossible.
// Both now stand aside: the approach is left as the package drew it, and the
// stroke closes on the station so each leg reaches the platform on its own
// surveyed track. Drawn-vs-raw in the 成田 throat 90.3 m → 0.0 m; jp station
// anchoring 14 WARNING → 5 (the nine that go were all this fold: 成田 205,
// 会津若松 100, 二本木 100, 伊万里 95, 遠軽 88, 十和田南 81, 柏 68, 立野 67,
// 藤沢 65 — the five that stay are real and unreviewed).
//
// Two switchbacks read SHARPER afterwards and that is the fix, not a
// regression: 肥薩線 大畑 reports 160° and 小田急箱根 大平台 133° (was 148°)
// because the survey has those corners — raw carries 160° at
// 130.78504,32.16386 — and the displacement blend had been bending them away
// (drawn-vs-raw 15.5 m and 20.9 m, both 0.0 m now). 養老線 大垣 likewise trades
// a welded 126° corner for reversal_joint_redraws_track, which is the honest
// description: the two legs really do share that rail.
//
// One station more than the note above: 中央線 gains 塩尻 and the 3.96 km of
// みどり湖–塩尻 that no stroke drew, once partition_by_audit stopped stripping a
// junction that sits at the end of a main path. 10219 → 10220 platforms, the
// line 67 → 68 stations and 215.755 km, and the count of lines does not move.
//
// 2026-08-19 stale alignments — counts unchanged (654 / 10220 / 654 / 9039),
// GEOMETRY changed on six intervals, which is why this digest moves alone. We
// were drawing track that no longer exists: the standing basemap audit
// (validate-basemap-alignment.mjs) measures every drawn metre against OSM's own
// disused/abandoned/razed ways, and six intervals were sitting ON a removed
// alignment or in a vacuum.
//   * 福知山線 尼崎–塚口 292.6 m → 9.9 m. Nothing was imported: the CURRENT
//     alignment is in N02-25 as RailroadSection #9405 (1,669 m via the 塚口
//     curve) and the walk had simply taken the shorter #9404 (1,222 m), which
//     is the 上り線 abandoned when the JR東西線 opened in 1997. 2.497 → 2.941 km,
//     which is longer than the 営業キロ because the 1997 route is.
//   * 筑豊線 折尾–東水巻 268.9 → 11.5 m (2022 折尾 rebuild), 飯田線 城西–向市場
//     137.5 → 11.9 m (1977 第一久頭合 relocation), 奥羽線 板谷–庭坂 282.1 →
//     57.3 m (板谷トンネル), 芸備線 甲立–上川立 262.2 → 12.1 m (2006 郷原
//     トンネル) — all four take OSM's current running track for the separated
//     span only, from evidence/stale-alignment-geometry.json.
//   * 奥羽線-p1 陣場–白沢 303.6 → 10.5 m: the second bore, where N02 carries one
//     coarse centre-line for the 松原トンネル. Same defect and same fix as
//     上越線's 湯檜曽ループ in paired-alignment-geometry.json.
// The lead-in and run-out of every replaced interval keep N02 vertex for vertex,
// so 福知山線 still shares the 尼崎 throat with 東海道線 and 奥羽線-p1 still
// merges into its trunk, both vertex for vertex. jp basemap audit ERROR 6 → 0.
// 2026-08-19 platform outlines and the end of the track — counts unchanged
// (654 / 10220 / 654 / 9039), thirteen station dots moved and five approaches
// stopped being reshaped, which is the whole of this digest's move.
//   * Every platform registered in station-anchor-overrides.json is a closed
//     OSM way, and the builder was reading each one as an open polyline: half
//     the perimeter of an outline is its far END, not its middle, so twelve
//     dots stood 15.1 m to 187.5 m past the platform they mark. Measured
//     against the track each line CLAIMS: 和歌山市 116.1 → 20.7 m, 橿原神宮前
//     108.3 → 24.8, 糸魚川 90.3 → 24.2, 宮古 32.1 → 6.0, 京成高砂 9.3 → 0.1,
//     横浜 5.8 → 2.4. The remaining metres at the first three are longitudinal
//     — those named ways STOP at the buffer, and the distance is to their last
//     vertex, not across the rails.
//   * The thirteenth, 東武日光, is withdrawn rather than re-measured. Its N02
//     feature was already 0.2 m from way 24403347 (東武日光線, 東武鉄道); the
//     80.7 m that condemned it was the distance to a JR East siding whose name
//     survives normalisation as 日光線, and the platform the row then picked is
//     JR日光駅's. The dot had landed 81.8 m from its own line, and the stroke
//     stopped short of the real terminus; it is back on its own metals and the
//     line regains 220 m.
//   * The approach rebuild and its audit both used to ask "is the platform
//     beyond the end of the track" structurally — is the nearest point on the
//     path the last vertex — which is blind wherever the survey wobbles in the
//     final metres. 亀山's 紀勢線 stops on 5-7 m of jitter, so a platform 171 m
//     beyond the end read as a sideways displacement and the line was drawn up
//     to 78.2 m off its own survey, while the two 関西線 strokes at the same
//     coordinate tripped the structural test and were left exact. Both now
//     also read the terminal's own outbound heading, and a platform within 45°
//     of it is beyond the end. Five approaches stand aside: 亀山/紀勢線 78.2 m
//     → 0.0, 二俣新町 58.1 → 0.0, 東武日光 80.0 → 0.0, 上越線-p1 土樽 12.2 →
//     0.0, 羽後本荘 6.0 → 0.0, all now drawn exactly on the package's own
//     coordinates. jp station anchoring 5 WARNING → 0, and the sideways case
//     is still measured: 東武日光's misplaced dot read 93° off axis and would
//     have been reported.
//
// 2026-08-19 宇品線 revert — the digest does NOT move, and that is the point:
// batch 2's 広島電鉄 宇品線 row is withdrawn, so the published 20-stop line is
// what the builder now produces again, byte for byte. The row moved 紙屋町西
// 162.2 m onto 鯉城通り, and every consequence followed from that one dot: the
// 紙屋町西–本通 interval drew 0.067 km against an audited 0.228, the graph cut
// 紙屋町西–紙屋町東 instead of 紙屋町西–本通, and the line came out as a
// 19-stop trunk without 紙屋町東 plus a 2-stop sibling. The platform it moved
// to is 本通's northbound one (way/929779365, 67 m from 本通's own dot, 56 m
// from the platform 本通 itself picks) — 宇品線 branches from 本線 at the
// 紙屋町 crossing and has no platform of its own there, so both its northern
// termini stand on 本線's 相生通り metals and lost the adjacency test to a
// platform down the branch. pickPlatform now discards a platform that stands
// nearer another stop of the same line; with the real 紙屋町西 platforms back
// in the ranking the audit reads the dot as systematic_line_offset — 34.0 m
// from the claimed track against a 24 m approach median — so the row is not
// proposed at all any more.
//
// 2026-08-19 redrawn-track pseudo-edges — 652 / 10216 / 652 / 9039, down 2
// lines and 4 station rows. Three contracted edges are gone because no line
// section corresponds to them, and each was making the map paint track a
// neighbouring hop already painted (block
// redrawn_track_pseudo_edge_removals_2026_08_19 of
// evidence/network-corrections-2026-08-13.json).
//
//   * 予讃線 五郎—新谷 is the fourth side of the 伊予若宮信号場 wye. The three
//     legs leave that node — 1,208 m from 五郎, 2,348 m from 伊予大洲 — on
//     bearings 29.3° / 57.6° / 210.3°, so 五郎 and 新谷 sit 28.3° apart and the
//     edge is a 152° reversal. Officially there is 高松—宇和島 297.6 km,
//     向井原—内子 23.5 and 新谷—伊予大洲 5.9; 五郎—新谷 was the 内子線's own
//     first section until 1986-03-03, the day the 新線 opened. 予讃線-3 is now
//     新谷 → 伊予大洲 alone, 5.843 km against that official 5.9, and the 3.26 km
//     it used to draw twice is drawn once.
//   * 東北線 王子—日暮里 and 東十条—日暮里 both ride the 日暮里—尾久—赤羽 支線
//     past 尾久 — 372 m from its platform, INSIDE drop_skip_station_edges' 400 m
//     window, and still never cut. Not by `keep`, not by `shield`, not by the
//     connectivity guard: 東北線's N02 sections fall into three groups
//     (389 / 8 / 3), 日暮里's platform is the only one of that corridor to
//     project onto the 8-section island at 139.77069,35.72840, and
//     path_between returns None for every pair ending there — so
//     stations_passed_by_cut answers "no track could be cut" with the empty
//     list, which the caller reads as "skips nobody". Every other pseudo-edge
//     of the clique (東十条—尾久, 東十条—鶯谷, 王子—鶯谷, 尾久—鶯谷) was cut
//     normally. With these two gone the 電車線 trunk runs
//     赤羽→東十条→王子→上中里→田端→西日暮里→日暮里→上野→…→東京 on 東北線-2,
//     the 支線 is 尾久→日暮里 2.723 km against an official 2.7 on 東北線-3, and
//     東北線-4's 168° fold 265 m short of 日暮里 is gone with the stroke that
//     drew it. 東北線-5 (王子—上中里) folds into the trunk too.
//
// The audit reads 652 lines, 11 WARNING, 0 ERROR: reversal_joint_redraws_track
// 2 → 1 (only 養老線's real 大垣 reversal is left),
// interval_doubles_back_at_station 6 → 5 and sharp_artificial_turn 11 → 10.
// N02 coverage of 東北線 loses 0.85 km, all of it inside the parallel window
// where the 電車線 already draws the corridor; isolatedKm stays 0.
// 2026-08-19 service spans — 658 / 10216 / 652 / 9039, up six segment
// FEATURES and not one metre of railway. The package gained an optional
// line-level `serviceSpans` (version 2025.5.0), derived by lib/service_status.py
// from the edge-level `network_status` the 2026-08-13 audit already keeps, and
// the renderer cuts each marked line into the stretch that still runs trains
// and the stretch that does not so the second can be drawn broken.
//
// Seven lines carry a drawable span — 肥薩線 八代—吉松 86.5 km, 米坂線
// 今泉—坂町 67.9, 美祢線 全線 46.1, 日田彦山線 夜明—添田 29.2, 津軽線
// 蟹田—三厩 28.6, 黒部峡谷 猫又—欅平 7.7, 湯前線 人吉温泉—肥後西村 5.8 —
// 271.8 km in all. Six of them keep an open stretch and add one feature each;
// 美祢線 is closed end to end and swaps its single feature for a closed one,
// which is why the count rises by six rather than seven. 陸羽西線's
// `all_trains_pass` spans are carried in the package and deliberately NOT
// drawn: its trains run and its track is ordinary railway, and two of its
// stations are passed without stopping — a fact about stations.
//
// 美祢線 and 日田彦山線 were `active` in all three inventory tables until this
// batch; both have been out of rail service since 2023 (JR West's standing
// 長期運転見合わせ page lists 美祢線 and nothing else; JR Kyushu's 添田—夜明 has
// run as BRT ひこぼしライン since 2023-08-28, with 鉄道事業廃止 filed 2025-12-26
// for 2027-03-31 — a DELETION for a later batch, not a status change).
//
// The cut is lossless and was proved so before the hash moved: the open and
// closed features of every split line re-cover their line's whole
// displayPartsForLine geometry to within a metre (japan-rail-continuity), and
// running the NEW renderer against the OLD package reproduced this file's
// previous digest exactly — the field is additive and a package without it
// renders as it always did. 肥薩線 needed the interval-by-interval cut rather
// than a run-by-run one: its stroke breaks at the 大畑 ループ reversal, in the
// middle of the closed section, and reading the span as two runs left the
// 9.4 km 大畑—矢岳 leg drawn solid.
//
// 2026-08-20 (tie-proof node identity): 函館線 was two display strokes cut at
// 札幌 because two bit-different copies of the same 苗穂 junction point — 3e-9 m
// apart — rounded to different NODE_DP cells under Python's ties-to-even, and
// that single disagreement was the ONLY contact between the 函館 and 旭川 halves
// of the railway. `_quantise` scales before rounding, the halves join, and the
// package draws one 函館 → 旭川 line of 422.5 km against the official 423.1.
// One line leaves (the 砂原支線 renumbers -3 → -2) and 札幌 stops being counted
// on two strokes. Nothing else nationwide moves: of the fourteen railways with
// more than one track group, this was the only one split by a tie rather than
// by a real survey gap — the next-closest is 山陽線 at 22.5 m.
//
// 2026-08-20 (stale alignments, batch 2): counts do not move (657 / 10215 /
// 651 / 9039) — six intervals change GEOMETRY and one station dot moves, which
// is why this digest travels alone. 信越線 宮内–長岡 swaps to N02-25's own
// RailroadSection #14996 (107 → 6.7 m); 両毛線 思川–栃木 comes off 栃木県道31号,
// where 31 of #17483's vertices were digitised (192 → 23 m); 播但線 京口–姫路
// (76 → 42 m), 富良野線 旭川–神楽岡 (92 → 33 m) and 宗谷線 旭川四条–旭川
// (45 → 32 m) come off the pre-elevation alignments of the 2008 姫路 and 2010
// 旭川 rebuilds. All five are registered in
// evidence/stale-alignment-geometry.json with their way ids and before/after
// deviations. The station dot is 大糸線's at 松本, which stood on the 篠ノ井線
// island 122 m from its own platform and now stands on 6;7; 大糸線 and
// 篠ノ井線 no longer share a source coordinate there, which is correct — they
// are two different islands and the audit classifies the pair C.
//
// 2026-08-20 (official line colours, all five countries): geometry, counts and
// station dots are untouched — every difference is a colour. jp's line-level
// colour coverage goes from 71 to 477 of 597 canonical lines (26 official + 394
// documented + 57 candidate) after reading ja.wikipedia's 日本の鉄道ラインカラー一覧
// and, for the residue nothing else colours, each line's own article; and every
// country now carries `colorReference` (the operator's published value) beside
// the `color` / `colorDark` display variants, which move HSL lightness only,
// far enough to clear 3:1 against this app's map surfaces. tw / hk / kr / mo had
// no dark variant at all before, and 37 of their strokes did not clear the
// surface they were drawn on.
// 2026-08-21 — 651 lines still, structure rows 18129 → 18127. Three station
// dots move onto the platform their own line serves and one branch changes the
// station it hangs from, so geometry moves while nothing is added or removed:
// 立川 leaves the 中央線 platform section N02 files twice for 青梅線 (the
// interval stops running down the 青梅短絡線, 314 m → 9.4 m from a way named
// 青梅線), 姫路 drops 48 m south onto the island 播但線 and 姫新線 actually use
// (52.5 → 4.2 m, and the elbow the old dot forced goes 70.7° → 20.1°), the
// 尾久 支線 hangs from 東十条 instead of 王子 so its 146° fold is gone
// geometrically, and 鶯谷 returns to the 電車線 where its trains run.
export const EXPECTED_RENDER_HASH =
  "71670a37c719e8eb1beb51ef1b3cfc62fa39800de47d5a04556600afdaa955fd";

const SNAPSHOT_DECIMAL_PLACES = 10;

function canonicalizeRenderValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    return Number(value.toFixed(SNAPSHOT_DECIMAL_PLACES));
  }
  if (Array.isArray(value)) return value.map(canonicalizeRenderValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        canonicalizeRenderValue(child),
      ]),
    );
  }
  return value;
}

export function renderRelevantSnapshot(network) {
  return canonicalizeRenderValue({
    version: network.version,
    segments: network.segments.features,
    stations: network.stations.features,
    lines: [...network.lineById.entries()],
    stationRows: [...network.stationById.entries()],
    groups: [...network.groupMembers.entries()].map(([key, rows]) => [
      key,
      rows.map((row) => row.stationId),
    ]),
  });
}
