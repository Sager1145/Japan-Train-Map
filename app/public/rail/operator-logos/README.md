# Rail operator logos

## Japan

Japanese routes keep the package-provided badge in `../logos/` whenever one
exists. For routes without one, `jp/` contains a company-level fallback. The
current package has 349 dedicated Japanese line badges; the operator fallbacks
cover 242 of the remaining 245 routes (85 of 87 operators).

Every downloaded file, its operator, source page, license/source type, and the
number of affected routes are recorded in [`jp/manifest.json`](jp/manifest.json).
The sources are the operator article's current [Wikidata logo (P154)](https://www.wikidata.org/wiki/Property:P154),
the [Wikimedia Commons Japanese rail-operator SVG category](https://commons.wikimedia.org/wiki/Category:SVG_logos_of_rail_transport_companies_of_Japan),
or the operator's current official website. Run
`node scripts/sync-japan-operator-logos.mjs` from `app/` to reproduce the
download without overwriting existing assets; pass `--overwrite` to refresh
them intentionally.

`万葉線` and `鞍馬寺` do not publish a distinct operator logo in the checked
sources. Their three lines deliberately retain the established color-swatch
fallback instead of using a fabricated or unrelated mark.

The complete mapping was refreshed against those live sources on 2026-08-07.
Automated popup tests verify all 349 package-provided line badges, all 85
operator fallbacks, their image signatures, and the exact operator-to-manifest
assignment. Four official marks are designed for dark website headers (青函
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
