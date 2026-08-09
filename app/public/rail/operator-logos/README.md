# Rail operator logos

## Japan

Japanese routes keep a package-provided badge in `../logos/` only after its
scope is verified against the corresponding line. The old package flag merely
meant that an image existed: 64 of its 349 images were actually company marks,
generic Shinkansen marks, regional JR codes applied beyond their official
scope, historical predecessor marks, or a parent-company mark. The audited
runtime therefore treats 285 images as line badges and sends the other 309
routes through the exact operator fallback. In total, 591 of 594 Japanese
routes resolve to a verified line or operator mark; the three deliberate
exceptions are the two 万葉線 routes and 鞍馬寺, whose operators publish no
distinct mark in the checked sources.

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
predecessor marks on 養老鉄道 and 伊賀鉄道, and the Keisei parent mark on
筑波観光鉄道 are explicitly rejected. The latter three now use current assets
from each operator's official site; 四日市 uses its current YAR company mark.

`万葉線` and `鞍馬寺` do not publish a distinct operator logo in the checked
sources. Their three lines deliberately retain the established color-swatch
fallback instead of using a fabricated or unrelated mark.

The complete mapping was re-audited against those live sources on 2026-08-09.
Automated popup tests verify the 285 accepted line badges, all 309 fallback
decisions, the 88 downloaded operator assets, their image signatures, and the
exact operator-to-manifest assignment. Four official marks are designed for dark website headers (青函
トンネル記念館, 四国ケーブル, 錦川鉄道, 阿佐海岸鉄道); the popup gives
only those original assets a dark matte so they remain legible in light mode.

## Taiwan

These marks identify Taiwan operators throughout the app and provide the
fallback in railprint's station hover popup when a route has no dedicated
line badge. Metro and light-rail routes with a line identity use the assets in
`../line-logos/` first.

| Asset | Operator | Source |
| --- | --- | --- |
| `tra.svg` | Taiwan Railway | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:ROC_Taiwan_Railways_Administration_Logo.svg) |
| `thsr.svg` | Taiwan High Speed Rail | transparent flying-flags mark from [CompaniesLogo](https://companieslogo.com/taiwan-high-speed-rail/logo/), visually checked against the [official corporate identity page](https://www.thsrc.com.tw/ArticleContent/605d1cb2-2d98-4d73-9586-7e8363ee44e3) |
| `trtc.svg` | Taipei Metro | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Taipei_mrt_logo.svg) |
| `ntmetro.svg` | New Taipei Metro | [Wikipedia file page](https://zh.wikipedia.org/wiki/File:New_Taipei_Metro_logo.svg) |
| `tym.png` | Taoyuan Metro | [official corporate identity page](https://www.tymetro.com.tw/tymetro-new/en/_pages/about/cis.html) |
| `tcmrt.svg` | Taichung Metro | [Wikipedia file page](https://zh.wikipedia.org/wiki/File:Taichung_Metro_logo.svg) |
| `krtc.svg` | Kaohsiung Metro | [Wikipedia file page](https://zh.wikipedia.org/wiki/File:Kaohsiung_Metro.svg); [official identity reference](https://corp.krtc.com.tw/eng/About/page?id=9c81a5246b014c06bcc1bcd55b025610) |
| `alsr.svg` | Alishan Forest Railway | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Logo_of_alishan_forest_railway.svg) |

The logos and trademarks remain the property of their respective owners.
