# Rail operator logos

## Japan

Japanese routes keep a package-provided badge in `../logos/` only after its
scope is verified against the corresponding line. The old package flag merely
meant that an image existed: 65 of its 349 images were actually company marks,
generic Shinkansen marks, regional JR codes applied beyond their official
scope, historical predecessor marks, or a parent-company mark. The audited
runtime therefore treats 284 images as line badges; four further routes carry
an official line symbol through the branding override table (北勢線 uses the
三岐鉄道 route letter H from [Commons File:SG number-H.svg](https://commons.wikimedia.org/wiki/File:SG_number-H.svg),
CC BY-SA 4.0 by 渡海千明, stored as `../line-logos/sangi-hokusei.svg`; the
丸ノ内線分岐線 reuses the package's Marunouchi M badge; 京都市営地下鉄東西線
uses its official vermillion T from [Commons File:Subway KyotoTozai.svg](https://commons.wikimedia.org/wiki/File:Subway_KyotoTozai.svg),
CC0, stored as `../line-logos/kyoto-tozai.svg`; 北海道新幹線 uses the
[JR Hokkaido Shinkansen pictogram](https://commons.wikimedia.org/wiki/File:Shinkansen_jrh.svg),
CC BY-SA 4.0 by KANAO22, supplied as `Shinkansen_jrh.svg` and stored unchanged
as `../line-logos/hokkaido-shinkansen.svg`). 仙台市's two subway lines
publish official N/T symbols, but no Commons or official-site asset exists to
source them from, so they deliberately keep the bureau mark. The remaining routes
go through the exact operator fallback. In total, 597 of 600 Japanese routes
resolve to a verified line or operator mark; the three deliberate exceptions
are the two 万葉線 routes and 鞍馬寺, whose operators publish no distinct mark
in the checked sources.

Operator ownership follows the package's `N02_004` value, the Japanese MLIT
field defined as the company operating the line. Regional JR letter badges are
accepted only where the package line has the same scope as the operator's
published route identity; the audit references the official [JR East station
numbering scope](https://www.jreast.co.jp/press/2016/20160402.pdf), [JR Central
scope](https://jr-central.co.jp/news/release/_pdf/000035928.pdf), [JR West line
symbol guide](https://www.westjr.co.jp/travel-information/en/train-usage-guide/howto/howtosign/),
and [JR Kyushu route maps](https://www.jrkyushu.co.jp/railway/routemap/index.html).

Every downloaded file, its operator, source page, license/source type, and the
number of affected routes are recorded in [`jp/manifest.json`](jp/manifest.json).
The sources are the operator article's current [Wikidata logo (P154)](https://www.wikidata.org/wiki/Property:P154),
the [Wikimedia Commons Japanese rail-operator SVG category](https://commons.wikimedia.org/wiki/Category:SVG_logos_of_rail_transport_companies_of_Japan),
or the operator's current official website. Run
`node scripts/sync-japan-operator-logos.mjs` from `app/` to reproduce the
download without overwriting existing assets; pass `--overwrite` to refresh
them intentionally.

The legacy Mie Railway mark on 四日市あすなろう鉄道・内部線, the 1911/1917
predecessor marks on 養老鉄道 and 伊賀鉄道, the pre-1944 北勢鉄道 mark on
三岐鉄道・北勢線, and the Keisei parent mark on 筑波観光鉄道 are explicitly
rejected. 養老・伊賀・筑波 now use current assets from each operator's
official site; 四日市 uses its current YAR company mark; 北勢線 uses its
official route-letter badge and 三岐鉄道's fallback is the company's current
Commons mark (`jp/q7418001.svg`). The regional JR letter codes JA (鹿児島本線)
on the package's 山陽線 entry is likewise rejected — JR九州 assigns no symbol
to its 山陽線 section — so that route falls back to the JR九州 mark.

`万葉線` and `鞍馬寺` do not publish a distinct operator logo in the checked
sources. Their three lines deliberately retain the established color-swatch
fallback instead of using a fabricated or unrelated mark.

The complete mapping was re-audited against those live sources on 2026-08-10,
including a visual pass over all 407 displayed assets. Automated popup tests
verify the 284 accepted line badges, the four line-symbol overrides, all
fallback decisions, the 89 downloaded operator assets, their image signatures,
and the exact operator-to-manifest assignment.

Japanese operator fallbacks follow the same emblem-first presentation as the
other regions. The 122 runtime decisions are recorded in
[`jp-badges/manifest.json`](jp-badges/manifest.json): 33 combination marks use
a crop containing only their independent emblem, 65 source files are already
emblem-like and remain unchanged, and 24 wordmarks remain unchanged because
their verified source provides no independently usable emblem. In the last
case the original logo is deliberately retained instead of replacing it with a
color swatch. Original source files remain in `jp/`; derived emblem crops are
stored in `jp-badges/`. The light-on-dark marks for 青函トンネル記念館,
四国ケーブル, and 阿佐海岸鉄道 receive a dark matte so they remain legible
in light mode.

Municipal tram fallbacks use their passenger-facing transit identity. 札幌市電
uses the emblem-only ST mark cropped from the current
[札幌市交通局 official header](https://www.city.sapporo.jp/st/), rather than
the separate corporate mark of the company contracted to operate the service.
函館市電 uses the blue emblem cropped from the current
[函館市企業局交通部 official header](https://www.city.hakodate.hokkaido.jp/tram/).

## Taiwan

These marks identify Taiwan operators throughout the app and provide the
fallback in railprint's station hover popup when a route has no dedicated
line badge. Metro and light-rail routes with a line identity use the assets in
`../line-logos/` first.

| Asset | Operator | Source |
| --- | --- | --- |
| `tra.svg` | Taiwan Railway | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:ROC_Taiwan_Railways_Administration_Logo.svg) |
| `thsr.svg` | Taiwan High Speed Rail | transparent flying-flags mark from [CompaniesLogo](https://companieslogo.com/taiwan-high-speed-rail/logo/), visually checked against the [official corporate identity page](https://www.thsrc.com.tw/ArticleContent/605d1cb2-2d98-4d73-9586-7e8363ee44e3) |
| `trtc-badge.png` | Taipei Metro | green-blue rail emblem cropped from the [Wikimedia Commons combination mark](https://commons.wikimedia.org/wiki/File:Taipei_mrt_logo.svg) |
| `ntmetro.svg` | New Taipei Metro | [Wikipedia file page](https://zh.wikipedia.org/wiki/File:New_Taipei_Metro_logo.svg) |
| `tym.png` | Taoyuan Metro | [official corporate identity page](https://www.tymetro.com.tw/tymetro-new/en/_pages/about/cis.html) |
| `tcmrt.svg` | Taichung Metro | [Wikipedia file page](https://zh.wikipedia.org/wiki/File:Taichung_Metro_logo.svg) |
| `krtc-badge.png` | Kaohsiung Metro | blue `K` emblem cropped from the [Wikipedia combination mark](https://zh.wikipedia.org/wiki/File:Kaohsiung_Metro.svg); checked against the [official identity reference](https://corp.krtc.com.tw/eng/About/page?id=9c81a5246b014c06bcc1bcd55b025610) |
| `alsr-badge.png` | Alishan Forest Railway | red mountain/rail emblem cropped from the [Wikimedia Commons combination mark](https://commons.wikimedia.org/wiki/File:Logo_of_alishan_forest_railway.svg) |

Every runtime Taiwan operator asset is the emblem only; company-name lettering
is rendered separately by the popup. The three cropped PNGs retain the source
artwork's original shape, color and transparency without redrawing it.

The logos and trademarks remain the property of their respective owners.

## Hong Kong

`mtr-badge.png` is the red railway emblem cropped from the current transparent
MTR wordmark downloaded from the official MTR journey-planner header at
<https://www.mtr.com.hk/en/customer/images/logo_5.png>. Only the emblem is
retained because the popup already renders the `MTR` company name as text. MTR
does not publish separate badge artwork for its heavy-rail lines on the system
map, so this emblem is the intentional fallback for those lines.

## Macao

`macao-lrt-badge.png` is the blue-green `M` emblem cropped from the current
transparent Macao LRT corporate wordmark used in the header of the
[official Macao LRT website](https://www.mlm.com.mo/), downloaded directly
from <https://www.mlm.com.mo/images/Logo.png> on 2026-08-10. Only the emblem is
retained because the popup already renders the `澳門輕軌` company name as text.
Macao LRT does not publish separate route badges for the Taipa, Seac Pai Van
and Hengqin lines, so all three intentionally use this verified operator mark.

The logo and trademark remain the property of Macao Light Rapid Transit
Corporation, Limited.
