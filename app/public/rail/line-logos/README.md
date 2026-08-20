# Taiwan line badges

Railprint uses these route-code badges before falling back to the operating
company mark. Branches that keep the same public line code intentionally share
one asset (for example, R and the Xinbeitou branch).

| Assets | Lines | Reference |
| --- | --- | --- |
| `trtc-bl.svg`, `trtc-r.svg`, `trtc-g.svg`, `trtc-o.svg`, `trtc-br.svg` | Taipei Metro BL/R/G/O/BR | Wikimedia Commons route symbols: [BL](https://commons.wikimedia.org/wiki/File:Taipei_Metro_Line_BL.svg), [R](https://commons.wikimedia.org/wiki/File:Taipei_Metro_Line_R.svg), [G](https://commons.wikimedia.org/wiki/File:Taipei_Metro_Line_G.svg), [O](https://commons.wikimedia.org/wiki/File:Taipei_Metro_Line_O.svg), [BR](https://commons.wikimedia.org/wiki/File:Taipei_Metro_Line_BR.svg) |
| `ntmetro-y.svg`, `ntmetro-v.svg`, `ntmetro-k.svg` | New Taipei Metro Y/V/K | Wikimedia Commons route symbols: [Y](https://commons.wikimedia.org/wiki/File:New_Taipei_Metro_Line_Y.svg), [V](https://commons.wikimedia.org/wiki/File:New_Taipei_Metro_Line_V_Danhai_LRT.svg), [K](https://commons.wikimedia.org/wiki/File:New_Taipei_Metro_Line_K.svg) |
| `tym-a.svg` | Taoyuan Metro A | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Taoyuan_Metro_Line_A.svg) |
| `tcmrt-g.svg` | Taichung Metro Green Line (`1` badge) | cleaned vector paths from the [Wikimedia Commons Green Line icon](https://commons.wikimedia.org/wiki/File:Taichung_Metro_Green_Line_icon.svg) |
| `krtc-r.svg`, `krtc-o.svg`, `krtc-c.svg` | Kaohsiung Metro R/O/C | clean route-code badges using official-package line colors; Commons references: [R](https://commons.wikimedia.org/wiki/File:Kaohsiung_Rapid_Transit_Red_Line.svg), [O](https://commons.wikimedia.org/wiki/File:Kaohsiung_Rapid_Transit_Orange_Line.svg), [C](https://commons.wikimedia.org/wiki/File:Kaohsiung_Rapid_Transit_Circular_Line.svg) |

The route symbols and trademarks remain the property of their respective
owners. Wikimedia assets retain the licenses stated on their file pages.

# Japan line badges

| Asset | Line | Reference |
| --- | --- | --- |
| `tokyo-metro-marunouchi-branch.svg` | Tokyo Metro Marunouchi branch line (`Mb`) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Logo_of_Tokyo_Metro_Marunouchi_branch_Line.svg) |

## Shinkansen

JR publishes no per-route Shinkansen symbol. The mark passengers see on
signage is the operating company's own Shinkansen pictogram, and the route
itself is identified by its line colour and name. The popup therefore gives
every Shinkansen railway the official pictogram of the company that runs it,
instead of the JR company mark the operator fallback would otherwise supply.
Railways sharing an operator share a pictogram, and the two operator records
of the 北陸新幹線 each follow the company running that half.

The Japan package ships raster copies of these same five pictograms, but that
art stays outside the audited line-badge set — an operator pictogram is not a
route badge — so each railway is pointed at the vector original stored here.
Every file is the Commons asset kept byte for byte: no recolour, crop or
redraw. A popup test hashes all five so later edits cannot silently alter the
operators' artwork.

| Asset | Operator | Railways | Reference |
| --- | --- | --- | --- |
| `shinkansen-jr-hokkaido.svg` | JR北海道 | 北海道新幹線 | [Commons File:Shinkansen jrh.svg](https://commons.wikimedia.org/wiki/File:Shinkansen_jrh.svg), CC BY-SA 4.0 by KANAO22 |
| `shinkansen-jr-east.svg` | JR東日本 | 東北新幹線, 上越新幹線, 北陸新幹線 (JR東日本 segment) | [Commons File:Shinkansen jre.svg](https://commons.wikimedia.org/wiki/File:Shinkansen_jre.svg), CC BY-SA 4.0, vector by Carnby and Perhelion |
| `shinkansen-jr-central.svg` | JR東海 | 東海道新幹線 | [Commons File:Shinkansen jrc.svg](https://commons.wikimedia.org/wiki/File:Shinkansen_jrc.svg), CC BY-SA 4.0 by KANAO22 |
| `shinkansen-jr-west.svg` | JR西日本 | 山陽新幹線, 北陸新幹線 (JR西日本 segment) | [Commons File:Shinkansen jrw.svg](https://commons.wikimedia.org/wiki/File:Shinkansen_jrw.svg), CC BY-SA 4.0, credited to 西日本旅客鉄道 |
| `shinkansen-jr-kyushu.svg` | JR九州 | 九州新幹線, 西九州新幹線 | [Commons File:Shinkansen jrk.svg](https://commons.wikimedia.org/wiki/File:Shinkansen_jrk.svg), CC BY-SA 4.0 by Mliu92 |

# Hong Kong Light Rail route badges

The `mtr-lr-*.svg` badges reproduce the official Light Rail route numbers and
the route colours published by MTR's journey-planner payload. Heavy-rail lines
do not receive fabricated route-letter badges: they correctly fall back to the
official MTR company emblem in `../operator-logos/mtr-badge.png`.

Reference: <https://www.mtr.com.hk/en/customer/jp/index.php>
