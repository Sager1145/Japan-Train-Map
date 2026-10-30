# Rail operator logos

## Japan

Japanese routes keep a package-provided badge in `../logos/` only after its
scope is verified against the corresponding line. The old package flag merely
meant that an image existed: 65 of its 349 images were actually company marks,
generic Shinkansen marks, regional JR codes applied beyond their official
scope, historical predecessor marks, or a parent-company mark. The audited
runtime therefore treats 284 images as line badges; twelve further route
records carry a verified passenger-facing badge through the branding override
table (北勢線 uses the
三岐鉄道 route letter H from [Commons File:SG number-H.svg](https://commons.wikimedia.org/wiki/File:SG_number-H.svg),
CC BY-SA 4.0 by 渡海千明, stored as `../line-logos/sangi-hokusei.svg`; the
丸ノ内線分岐線 reuses the package's Marunouchi M badge; 京都市営地下鉄東西線
uses its official vermillion T from [Commons File:Subway KyotoTozai.svg](https://commons.wikimedia.org/wiki/File:Subway_KyotoTozai.svg),
CC0, stored as `../line-logos/kyoto-tozai.svg`; and the nine Shinkansen route
records each take the official Shinkansen pictogram of the company operating
them, because JR publishes no per-route Shinkansen symbol — the five
`../line-logos/shinkansen-jr-*.svg` assets, each stored unchanged and
documented in [`../line-logos/README.md`](../line-logos/README.md)).
仙台市's two subway lines
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
`node scripts/railway/sync-japan-operator-logos.mjs` from `app/` to reproduce the
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

The complete mapping was re-audited against those live sources on 2026-08-20,
including a visual pass over the displayed assets. Automated popup tests
verify the 284 accepted package badges, the twelve line-badge overrides, all
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

## United States and Canada

North American operators publish one company mark for many services, so the
association here is per operator rather than per line. A line in
`../us-2025.json` or `../ca-2025.json` carries an `operatorLogo` path when its
operator has an audited mark, and the mark it points at belongs to the company
that line's own GTFS names as its agency. The audited owner of that association
is the feed registry
[`../../../scripts/railway/na-feeds.json`](../../../scripts/railway/na-feeds.json):
`operatorLogo` for a feed that names one operator, and `operatorLogos` — keyed
by the operator name the package publishes — for a feed that carries several,
because assigning a consolidated feed's first mark to its other operators is
worse than leaving them unmarked. The files are in `na/`, and every one of them
is recorded in [`na/manifest.json`](na/manifest.json) with the Wikidata item it
came from, the Commons file, the fetched URL, and the file's licence and
attribution.

To reproduce the download, run

```
python3 scripts/railway/download-north-america-operator-logos.py \
    --registry scripts/railway/na-feeds.json \
    --output-dir public/rail/operator-logos/na \
    --manifest public/rail/operator-logos/na/manifest.json
```

from `app/`. It keeps assets already recorded and re-resolves the rest; pass
`--refresh` to refetch everything, or `--only <slug>` to work on one operator.

### How an operator gets a mark, and how it fails to

The resolver searches Wikidata for the names the feed publishes and takes the
matched item's current logo image (property P154) from Wikimedia Commons. Three
things went wrong with that often enough to be worth naming, because each one
had already shipped a wrong or retired mark:

* **The published name is not the name Wikidata knows.** An `agency_name` is a
  legal name, an initialism, or a legal name with the initialism in brackets.
  Searching it as published answered "Massachusetts Bay Transportation
  Authority (MBTA)" with a state open-data portal, and 32 MBTA lines went
  unbranded. Names are now searched as published, with the brackets removed,
  and as whatever was inside them; and the best-scoring candidate is no longer
  the only one tried, because the old rule let an operator that publishes no
  logo block the operator that does.
* **A name can match something that is not a railway.** `CATS` is Charlotte's
  transit system and also the 1981 Andrew Lloyd Webber musical, whose logo
  shipped on two Charlotte light-rail lines; `exo` is Montreal's commuter
  operator and also a South Korean boy band, whose logo shipped on five
  Montreal lines. Both are fixed. A candidate must now also *say* it has
  something to do with transport before its artwork is allowed onto a railway.
* **An operator's logo statement is not always its current mark.** Wikidata
  records the marks a company has used, and taking the first one shipped
  WeGo Public Transit's pre-2018 Nashville MTA mark and Pittsburgh Regional
  Transit's pre-2022 Port Authority of Allegheny County mark — the same
  predecessor-mark category the Japanese audit above rejects. Statements ranked
  deprecated, and statements carrying an end date, are now skipped, and a
  statement the editors ranked preferred wins. The Muni "worm", the current
  CapMetro mark and the current LA Metro mark are kept by the same rule.

Where none of that can decide, a person did, and the answer is a row in
[`../../../scripts/railway/na-operator-brands.json`](../../../scripts/railway/na-operator-brands.json)
naming the operator the mark must belong to and why the automatic answer was
not usable — a table to re-read rather than a constant inside the resolver.

### Marks that were rejected

The Japanese audit's categories hold here. A parent government's seal is not
the railway's mark: Connecticut's two commuter services take CTrail, the
department's own rail brand, rather than the Connecticut Department of
Transportation logo, and SunRail's own mark rather than the Florida Department
of Transportation's. A predecessor's mark is not the operator's: Shore Line
East's remaining Commons file is the retired red "Connecticut Commuter Rail"
roundel from a 2011 timetable, and Metrolink's own Wikidata item still carries
the pre-2022 teal square rather than the blue wordmark the operator has used
since. Artwork that is not the operator's is not a substitute for it, however
convenient: `Shore Line East icon.png` is a Wikivoyage route icon,
`Nm-commuter-rail.svg` is a transit diagram a contributor drew for the New
Mexico Rail Runner Express, and `Hartlinelogo.JPG` — the only HART candidate on
Commons — is a photograph somebody took of a bus. The Long Island Rail Road
stopped borrowing the mark of its MTA sibling New York City Transit, which the
registry had pointed all 31 of its lines at, and now carries its own; and the
subway keeps New York City Transit's rather than taking the parent
Metropolitan Transportation Authority's corporate mark, which is what removing
the brackets from its feed's name would otherwise have reached.

Four marks belong to the operator but are its service brand rather than a
company mark, because the company publishes nothing else: SunRail for the
Florida DOT, CTrail for the Connecticut DOT, Capitol Corridor for the joint
powers authority that runs it, and Seattle Streetcar for the two City of
Seattle lines in King County Metro's feed. MDOT MTA is the one operator that
deliberately ends up with two: it publishes no agency mark at all, and its two
feeds are exactly one service each, so the MARC feed takes MARC's mark and the
subway feed takes Metro SubwayLink's. West Virginia University's own logo is
used for the Morgantown PRT because the PRT is a university facility rather
than a separate company — the distinction that makes it acceptable where a city
seal would not be.

### Licence and attribution

Every file here comes from Wikimedia Commons. Eighty of the 81 are published
there as **public domain** — a North American company mark that is lettering
and simple geometry is below the United States threshold of originality and
carries no copyright of its own. The exception is `patco-speedline.png`, from
[Commons File:PATCO Line.svg](https://commons.wikimedia.org/wiki/File:PATCO_Line.svg),
which is **CC BY-SA 4.0** and credited to the Commons contributor Vrysxy who
redrew the wordmark; it is kept because the only other PATCO file on Commons is
a Wikivoyage route icon, and its attribution and licence URL are in the
manifest row. Commons records the trademark separately from the copyright, and
for 65 of these files it does say `trademarked` (two say `insignia`); the
manifest records that per file in `restrictions`, along with the licence short
name, the attribution Commons states, the credit line naming the operator
document the artwork was taken from, and the Commons file page. Nothing here is
used under a fair-use rationale, and nothing needed one.

`../logo-credits.json` is not extended: it is keyed by line id and exists for
the Japanese per-line badges, where each line has its own artwork. A North
American mark belongs to an operator and is shared by every line that operator
runs, so `na/manifest.json` is the per-asset record and this section is the
prose one.

The logos and trademarks remain the property of their respective owners.

### The operators that still have no mark

Of the registry's 94 feeds, 81 carry an audited mark. Ten operators publish
none that any of the checked sources hold, and keep the colour-swatch fallback
rather than borrowing an unrelated one: Kenosha Transit, the City of
Milwaukee's The Hop, CamTran's Johnstown Inclined Plane, Memphis Area Transit
Authority, the New Orleans Regional Transit Authority, Galveston's Island
Transit, Hampton Roads Transit, Hillsborough Area Regional Transit, the Rio
Metro Regional Transit District and Tucson's Sun Tran. New Orleans is the
largest of them at nine streetcar lines; its Commons category is photographs of
streetcars and bus stops, and the authority publishes no artwork.

Two more have no mark because they have no single operator to have one: the
Puget Sound consolidated feed and Sound Transit's joint feed with King County
Metro name ten and four agencies respectively, and their rail lines are branded
per operator through the registry's `operatorLogos` instead. Both used to carry
Minneapolis's Metro Transit mark, because King County Metro publishes its
agency name as "Metro Transit" too. The Autoridad de Transporte Integrado in
Puerto Rico is separate again: its own terms reserve the use of its logo, so
the registry marks it `logoRestricted` and no asset is distributed.
