/*
 * Shared operator naming and logo rules.
 *
 * Taiwan itinerary records store a short passenger-facing company name, while
 * route constraints keep the rail package's full official operator name.
 */
const RailOperatorBranding = (() => {
  "use strict";

  const COMPANY_LABELS = Object.freeze({
    東日本旅客鉄道: "JR東日本",
    西日本旅客鉄道: "JR西日本",
    東海旅客鉄道: "JR東海",
    九州旅客鉄道: "JR九州",
    北海道旅客鉄道: "JR北海道",
    四国旅客鉄道: "JR四国",
    東京地下鉄: "東京メトロ",
    東京都: "都営",
    大阪市高速電気軌道: "大阪メトロ",
    名古屋市: "名古屋市営",
    横浜市: "横浜市営",
    神戸市: "神戸市営",
    京都市: "京都市営",
    札幌市: "札幌市営",
    仙台市: "仙台市営",
    福岡市: "福岡市営",
    熊本市: "熊本市電",
    鹿児島市: "鹿児島市電",
    函館市: "函館市電",
    一般社団法人札幌市交通事業振興公社: "札幌市電",
    東急電鉄: "東急",
    京王電鉄: "京王",
    京成電鉄: "京成",
    京浜急行電鉄: "京急",
    小田急電鉄: "小田急",
    西武鉄道: "西武",
    東武鉄道: "東武",
    相模鉄道: "相鉄",
    近畿日本鉄道: "近鉄",
    南海電気鉄道: "南海",
    京阪電気鉄道: "京阪",
    阪急電鉄: "阪急",
    阪神電気鉄道: "阪神",
    名古屋鉄道: "名鉄",
    西日本鉄道: "西鉄",
  });

  const TAIWAN_COMPANY_LABELS = Object.freeze({
    國營臺灣鐵路股份有限公司: "台鐵",
    臺灣鐵路股份有限公司: "台鐵",
    台灣鐵路股份有限公司: "台鐵",
    交通部臺灣鐵路管理局: "台鐵",
    臺灣鐵路管理局: "台鐵",
    台灣鐵路管理局: "台鐵",
    臺鐵: "台鐵",
    台鐵: "台鐵",
    台灣高速鐵路股份有限公司: "台灣高鐵",
    臺灣高速鐵路股份有限公司: "台灣高鐵",
    台灣高速鐵路: "台灣高鐵",
    臺灣高速鐵路: "台灣高鐵",
    臺灣高鐵: "台灣高鐵",
    台灣高鐵: "台灣高鐵",
    臺北大眾捷運股份有限公司: "台北捷運",
    台北大眾捷運股份有限公司: "台北捷運",
    臺北捷運: "台北捷運",
    台北捷運: "台北捷運",
    新北大眾捷運股份有限公司: "新北捷運",
    新北捷運股份有限公司: "新北捷運",
    新北捷運: "新北捷運",
    桃園大眾捷運股份有限公司: "桃園捷運",
    桃園捷運股份有限公司: "桃園捷運",
    桃園捷運: "桃園捷運",
    臺中捷運股份有限公司: "台中捷運",
    台中捷運股份有限公司: "台中捷運",
    臺中捷運: "台中捷運",
    台中捷運: "台中捷運",
    高雄捷運股份有限公司: "高雄捷運",
    高雄捷運: "高雄捷運",
    農業部林業及自然保育署阿里山林業鐵路及文化資產管理處: "阿里山林鐵",
    農業部阿里山林業鐵路及文化資產管理處: "阿里山林鐵",
    阿里山林業鐵路及文化資產管理處: "阿里山林鐵",
    阿里山林業鐵路: "阿里山林鐵",
    阿里山林鐵: "阿里山林鐵",
  });

  const HONG_KONG_COMPANY_LABELS = Object.freeze({
    MTR: "MTR",
    香港鐵路有限公司: "MTR",
    "香港鐵路有限公司 MTR Corporation": "MTR",
    "MTR Corporation Limited": "MTR",
    // Hong Kong Tramways is its own operator, not an MTR service; like the
    // Macao LRT it has no logo asset and shows as a company-name label.
    香港電車: "香港電車",
    香港电车: "香港電車",
    香港電車有限公司: "香港電車",
    "Hongkong Tramways Limited": "香港電車",
    "Hong Kong Tramways": "香港電車",
  });

  const MACAO_COMPANY_LABELS = Object.freeze({
    澳門輕軌: "澳門輕軌",
    澳门轻轨: "澳門輕軌",
    澳門輕軌股份有限公司: "澳門輕軌",
    澳门轻轨股份有限公司: "澳門輕軌",
    "Macao Light Rapid Transit Corporation, Limited": "澳門輕軌",
    "Macao LRT": "澳門輕軌",
  });

  // Badge-only crops from the verified Japanese operator artwork. These are
  // used only where the source publishes an independently usable emblem next
  // to its company-name lettering. Operators with no separable emblem retain
  // their original verified logo instead of falling back to a color swatch.
  const JAPAN_OPERATOR_BADGE_OVERRIDES = Object.freeze({
    アルピコ交通: "/rail/operator-logos/jp-badges/badge-001.png",
    えちごトキめき鉄道: "/rail/operator-logos/jp-badges/badge-002.png",
    えちぜん鉄道: "/rail/operator-logos/jp-badges/badge-003.png",
    くま川鉄道: "/rail/operator-logos/jp-badges/badge-004.png",
    こうべ未来都市機構: "/rail/operator-logos/jp-badges/badge-005.png",
    しなの鉄道: "/rail/operator-logos/jp-badges/badge-006.png",
    とさでん交通: "/rail/operator-logos/jp-badges/badge-007.png",
    ラクテンチ: "/rail/operator-logos/jp-badges/badge-008.png",
    伊賀鉄道: "/rail/operator-logos/jp-badges/badge-009.png",
    一畑電車: "/rail/operator-logos/jp-badges/badge-010.png",
    一般財団法人青函トンネル記念館:
      "/rail/operator-logos/jp-badges/badge-011.png",
    一般社団法人札幌市交通事業振興公社:
      "/rail/operator-logos/jp-badges/badge-012.png",
    甘木鉄道: "/rail/operator-logos/jp-badges/badge-013.png",
    関東鉄道: "/rail/operator-logos/jp-badges/badge-014.png",
    京阪電気鉄道: "/rail/operator-logos/jp-badges/badge-015.png",
    錦川鉄道: "/rail/operator-logos/jp-badges/badge-016.png",
    近江鉄道: "/rail/operator-logos/jp-badges/badge-017.png",
    高松琴平電気鉄道: "/rail/operator-logos/jp-badges/badge-018.png",
    四日市あすなろう鉄道:
      "/rail/operator-logos/jp-badges/badge-019.png",
    鹿児島市: "/rail/operator-logos/jp-badges/badge-020.png",
    若桜鉄道: "/rail/operator-logos/jp-badges/badge-021.png",
    神戸六甲鉄道: "/rail/operator-logos/jp-badges/badge-022.png",
    水間鉄道: "/rail/operator-logos/jp-badges/badge-023.png",
    静岡鉄道: "/rail/operator-logos/jp-badges/badge-024.png",
    筑波観光鉄道: "/rail/operator-logos/jp-badges/badge-025.png",
    長野電鉄: "/rail/operator-logos/jp-badges/badge-026.png",
    東京メトロ: "/rail/operator-logos/jp-badges/badge-027.png",
    函館市: "/rail/operator-logos/jp-badges/badge-028.png",
    肥薩おれんじ鉄道: "/rail/operator-logos/jp-badges/badge-029.png",
    富士山麓電気鉄道: "/rail/operator-logos/jp-badges/badge-030.png",
    福井鉄道: "/rail/operator-logos/jp-badges/badge-031.png",
    野岩鉄道: "/rail/operator-logos/jp-badges/badge-032.png",
    立山黒部貫光: "/rail/operator-logos/jp-badges/badge-033.png",
  });

  // Company-level fallbacks for Japanese routes without a verified line
  // badge. Some older package assets are company marks (or worse, historical
  // predecessor/parent-company marks), so logoForLine() only treats package
  // artwork as a line badge when it is not in JAPAN_NON_LINE_LOGO_IDS below.
  const JAPAN_OPERATOR_LOGOS = Object.freeze({
    JR東海交通事業: "/rail/operator-logos/jp/q7862679.svg",
    "WILLER　TRAINS": "/rail/operator-logos/jp/q19727758.svg",
    えちごトキめき鉄道: "/rail/operator-logos/jp/q11260966.svg",
    えちぜん鉄道: "/rail/operator-logos/jp/q1007890.svg",
    くま川鉄道: "/rail/operator-logos/jp/q8194074.jpg",
    こうべ未来都市機構: "/rail/operator-logos/jp/q11237259.png",
    しなの鉄道: "/rail/operator-logos/jp/q11254401.svg",
    とさでん交通: "/rail/operator-logos/jp/q3537118.png",
    のと鉄道: "/rail/operator-logos/jp/q7063103.svg",
    アイジーアールいわて銀河鉄道: "/rail/operator-logos/jp/q5371026.svg",
    アルピコ交通: "/rail/operator-logos/jp/q4735443.svg",
    ラクテンチ: "/rail/operator-logos/jp/q11346676.png",
    一畑電車: "/rail/operator-logos/jp/q128426.svg",
    一般社団法人札幌市交通事業振興公社: "/rail/operator-logos/jp/q11521202.svg",
    一般財団法人青函トンネル記念館:
      "/rail/operator-logos/jp/seikan-tunnel-museum.png",
    三岐鉄道: "/rail/operator-logos/jp/q7418001.svg",
    三陸鉄道: "/rail/operator-logos/jp/q7418928.png",
    上田電鉄: "/rail/operator-logos/jp/q11263296.svg",
    丹後海陸交通: "/rail/operator-logos/jp/q11368524.png",
    九州旅客鉄道: "/rail/operator-logos/jp/q498366.svg",
    京福電気鉄道: "/rail/operator-logos/jp/q3537126.svg",
    京都市: "/rail/operator-logos/jp/q5359594.svg",
    京阪電気鉄道: "/rail/operator-logos/jp/q1188274.svg",
    伊予鉄道: "/rail/operator-logos/jp/q3138970.svg",
    伊賀鉄道: "/rail/operator-logos/jp/iga-railway.png",
    信楽高原鐵道: "/rail/operator-logos/jp/q7496306.jpg",
    函館市: "/rail/operator-logos/jp/q3082613.png",
    北大阪急行電鉄: "/rail/operator-logos/jp/q2323022.svg",
    北条鉄道: "/rail/operator-logos/jp/q11402201.png",
    北海道旅客鉄道: "/rail/operator-logos/jp/q498930.svg",
    北陸鉄道: "/rail/operator-logos/jp/q5878320.svg",
    十国峠: "/rail/operator-logos/jp/q11380603.svg",
    南阿蘇鉄道: "/rail/operator-logos/jp/q11408721.jpg",
    和歌山電鐵: "/rail/operator-logos/jp/q11417705.svg",
    四国ケーブル: "/rail/operator-logos/jp/q7496602.png",
    四国旅客鉄道: "/rail/operator-logos/jp/q496531.svg",
    四日市あすなろう鉄道: "/rail/operator-logos/jp/q17211160.svg",
    土佐くろしお鉄道: "/rail/operator-logos/jp/q7827542.png",
    大井川鐵道: "/rail/operator-logos/jp/q842075.svg",
    大山観光電鉄: "/rail/operator-logos/jp/q11434695.png",
    大阪モノレール: "/rail/operator-logos/jp/q1903962.svg",
    富士山麓電気鉄道: "/rail/operator-logos/jp/q116872861.svg",
    富山地方鉄道: "/rail/operator-logos/jp/q1131125.svg",
    山万: "/rail/operator-logos/jp/q11465832.png",
    山形鉄道: "/rail/operator-logos/jp/q11045417.svg",
    岡山電気軌道: "/rail/operator-logos/jp/q860466.svg",
    嵯峨野観光鉄道: "/rail/operator-logos/jp/q50187147.svg",
    平成筑豊鉄道: "/rail/operator-logos/jp/q3943894.svg",
    広島電鉄: "/rail/operator-logos/jp/q1196530.svg",
    御岳登山鉄道: "/rail/operator-logos/jp/q6880754.svg",
    明知鉄道: "/rail/operator-logos/jp/q8193797.svg",
    智頭急行: "/rail/operator-logos/jp/q4133832.svg",
    東京メトロ: "/rail/operator-logos/jp/q682894.svg",
    東日本旅客鉄道: "/rail/operator-logos/jp/q499071.svg",
    東海旅客鉄道: "/rail/operator-logos/jp/q513679.svg",
    松浦鉄道: "/rail/operator-logos/jp/q6788223.jpg",
    比叡山鉄道: "/rail/operator-logos/jp/q11547404.svg",
    熊本市: "/rail/operator-logos/jp/q900963.jpg",
    熊本電気鉄道: "/rail/operator-logos/jp/q5357168.svg",
    甘木鉄道: "/rail/operator-logos/jp/q11574278.png",
    由利高原鉄道: "/rail/operator-logos/jp/q11577568.png",
    皿倉登山鉄道: "/rail/operator-logos/jp/q11480880.png",
    神戸六甲鉄道: "/rail/operator-logos/jp/q130517459.png",
    神戸新交通: "/rail/operator-logos/jp/q5366038.svg",
    福井鉄道: "/rail/operator-logos/jp/q5507652.svg",
    福島交通: "/rail/operator-logos/jp/q5507741.svg",
    秋田内陸縦貫鉄道: "/rail/operator-logos/jp/q11595259.png",
    秩父鉄道: "/rail/operator-logos/jp/q843780.svg",
    立山黒部貫光: "/rail/operator-logos/jp/q11597848.png",
    若桜鉄道: "/rail/operator-logos/jp/q11616555.svg",
    西日本旅客鉄道: "/rail/operator-logos/jp/q502125.svg",
    西日本鉄道: "/rail/operator-logos/jp/q869251.svg",
    豊橋鉄道: "/rail/operator-logos/jp/q3081081.svg",
    近江鉄道: "/rail/operator-logos/jp/q3276327.png",
    遠州鉄道: "/rail/operator-logos/jp/q9286431.svg",
    野岩鉄道: "/rail/operator-logos/jp/q8046688.svg",
    錦川鉄道: "/rail/operator-logos/jp/q11650435.png",
    長崎電気軌道: "/rail/operator-logos/jp/q901485.png",
    長良川鉄道: "/rail/operator-logos/jp/q11653637.svg",
    長野電鉄: "/rail/operator-logos/jp/q6958437.svg",
    関東鉄道: "/rail/operator-logos/jp/q845943.svg",
    阿佐海岸鉄道: "/rail/operator-logos/jp/q11657221.svg",
    阿武隈急行: "/rail/operator-logos/jp/q4670567.svg",
    静岡鉄道: "/rail/operator-logos/jp/q5362040.svg",
    高尾登山電鉄: "/rail/operator-logos/jp/q7677245.svg",
    高松琴平電気鉄道: "/rail/operator-logos/jp/q566998.svg",
    筑波観光鉄道: "/rail/operator-logos/jp/tsukuba-kanko.png",
    養老鉄道: "/rail/operator-logos/jp/yoro-railway.webp",
    鹿児島市: "/rail/operator-logos/jp/q3537114.gif",
  });

  // Existing package assets whose source artwork is a company mark. Keep
  // these separate from verified line badges: they are valid only after the
  // line-level lookup has failed and the exact operator has been matched.
  const JAPAN_PACKAGE_OPERATOR_LOGOS = Object.freeze({
    沖縄都市モノレール:
      "/rail/logos/jp-沖縄都市モノレール-沖縄都市モノレール線.png",
    いすみ鉄道: "/rail/logos/jp-いすみ鉄道-いすみ線.png",
    わたらせ渓谷鐵道:
      "/rail/logos/jp-わたらせ渓谷鐵道-わたらせ渓谷線.png",
    愛知環状鉄道: "/rail/logos/jp-愛知環状鉄道-愛知環状鉄道線.png",
    伊勢鉄道: "/rail/logos/jp-伊勢鉄道-伊勢線.png",
    井原鉄道: "/rail/logos/jp-井原鉄道-井原線.png",
    会津鉄道: "/rail/logos/jp-会津鉄道-会津線.png",
    岳南電車: "/rail/logos/jp-岳南電車-岳南鉄道線.png",
    紀州鉄道: "/rail/logos/jp-紀州鉄道-紀州鉄道線.png",
    黒部峡谷鉄道: "/rail/logos/jp-黒部峡谷鉄道-本線.png",
    小湊鐵道: "/rail/logos/jp-小湊鐵道-小湊鐵道線.png",
    湘南モノレール: "/rail/logos/jp-湘南モノレール-江の島線.png",
    上信電鉄: "/rail/logos/jp-上信電鉄-上信線.png",
    上毛電気鉄道: "/rail/logos/jp-上毛電気鉄道-上毛線.png",
    真岡鐵道: "/rail/logos/jp-真岡鐵道-真岡線.png",
    水間鉄道: "/rail/logos/jp-水間鉄道-水間線.png",
    水島臨海鉄道: "/rail/logos/jp-水島臨海鉄道-水島本線.png",
    あいの風とやま鉄道:
      "/rail/logos/jp-あいの風とやま鉄道-あいの風とやま鉄道線.png",
    IRいしかわ鉄道:
      "/rail/logos/jp-IRいしかわ鉄道-IRいしかわ鉄道線.png",
    ハピラインふくい:
      "/rail/logos/jp-ハピラインふくい-ハピラインふくい線.png",
    青い森鉄道: "/rail/logos/jp-青い森鉄道-青い森鉄道線.png",
    仙台市: "/rail/logos/jp-仙台市-南北線.png",
    流鉄: "/rail/logos/jp-流鉄-流山線.png",
    多摩都市モノレール:
      "/rail/logos/jp-多摩都市モノレール-多摩都市モノレール線.png",
    筑豊電気鉄道:
      "/rail/logos/jp-筑豊電気鉄道-筑豊電気鉄道線.png",
    津軽鉄道: "/rail/logos/jp-津軽鉄道-津軽鉄道線.png",
    天竜浜名湖鉄道:
      "/rail/logos/jp-天竜浜名湖鉄道-天竜浜名湖線.png",
    島原鉄道: "/rail/logos/jp-島原鉄道-島原鉄道線.png",
    肥薩おれんじ鉄道:
      "/rail/logos/jp-肥薩おれんじ鉄道-肥薩おれんじ鉄道線.png",
    道南いさりび鉄道:
      "/rail/logos/jp-道南いさりび鉄道-道南いさりび鉄道線.png",
    北九州高速鉄道: "/rail/logos/jp-北九州高速鉄道-小倉線.png",
    仙台空港鉄道: "/rail/logos/jp-仙台空港鉄道-仙台空港線.png",
    ひたちなか海浜鉄道:
      "/rail/logos/jp-ひたちなか海浜鉄道-湊線.png",
  });

  // The original package flag only meant "an image was downloaded". It did
  // not prove that the image was a line badge. This exhaustive audit set
  // contains company marks, generic Shinkansen marks, out-of-scope regional
  // JR codes, three historical predecessor marks, and one parent-company
  // mark. These assets must never outrank the line's actual operator.
  const JAPAN_NON_LINE_LOGO_IDS = new Set([
    "jp-沖縄都市モノレール-沖縄都市モノレール線",
    "jp-いすみ鉄道-いすみ線",
    "jp-しなの鉄道-しなの鉄道線",
    "jp-わたらせ渓谷鐵道-わたらせ渓谷線",
    "jp-愛知環状鉄道-愛知環状鉄道線",
    "jp-伊勢鉄道-伊勢線",
    "jp-井原鉄道-井原線",
    "jp-会津鉄道-会津線",
    "jp-岳南電車-岳南鉄道線",
    "jp-紀州鉄道-紀州鉄道線",
    "jp-四日市あすなろう鉄道-内部線",
    "jp-九州旅客鉄道-九州新幹線",
    "jp-九州旅客鉄道-鹿児島線",
    "jp-九州旅客鉄道-山陽線",
    "jp-九州旅客鉄道-日豊線",
    "jp-黒部峡谷鉄道-本線",
    "jp-三岐鉄道-北勢線",
    "jp-小湊鐵道-小湊鐵道線",
    "jp-湘南モノレール-江の島線",
    "jp-上信電鉄-上信線",
    "jp-上毛電気鉄道-上毛線",
    "jp-真岡鐵道-真岡線",
    "jp-水間鉄道-水間線",
    "jp-水島臨海鉄道-水島本線",
    "jp-西日本旅客鉄道-関西線",
    "jp-西日本旅客鉄道-山陽新幹線",
    "jp-西日本旅客鉄道-山陽線",
    "jp-西日本旅客鉄道-赤穂線",
    "jp-西日本旅客鉄道-博多南線",
    "jp-西日本旅客鉄道-姫新線",
    "jp-あいの風とやま鉄道-あいの風とやま鉄道線",
    "jp-IRいしかわ鉄道-IRいしかわ鉄道線",
    "jp-ハピラインふくい-ハピラインふくい線",
    "jp-青い森鉄道-青い森鉄道線",
    "jp-仙台市-南北線",
    "jp-流鉄-流山線",
    "jp-多摩都市モノレール-多摩都市モノレール線",
    "jp-大井川鐵道-大井川本線",
    "jp-筑波観光鉄道-筑波山鋼索鉄道線",
    "jp-筑豊電気鉄道-筑豊電気鉄道線",
    "jp-津軽鉄道-津軽鉄道線",
    "jp-天竜浜名湖鉄道-天竜浜名湖線",
    "jp-島原鉄道-島原鉄道線",
    "jp-東海旅客鉄道-東海道新幹線",
    "jp-東日本旅客鉄道-上越新幹線",
    "jp-東日本旅客鉄道-常磐線",
    "jp-東日本旅客鉄道-成田線",
    "jp-東日本旅客鉄道-川越線",
    "jp-東日本旅客鉄道-中央線",
    "jp-東日本旅客鉄道-東海道線",
    "jp-東日本旅客鉄道-東北新幹線",
    "jp-東日本旅客鉄道-東北線",
    "jp-東日本旅客鉄道-北陸新幹線",
    "jp-肥薩おれんじ鉄道-肥薩おれんじ鉄道線",
    "jp-豊橋鉄道-渥美線",
    "jp-道南いさりび鉄道-道南いさりび鉄道線",
    "jp-北九州高速鉄道-小倉線",
    "jp-仙台空港鉄道-仙台空港線",
    "jp-ひたちなか海浜鉄道-湊線",
    "jp-養老鉄道-養老線",
    "jp-伊賀鉄道-伊賀線",
    "jp-西日本旅客鉄道-北陸新幹線",
    "jp-仙台市-東西線",
    "jp-北海道旅客鉄道-北海道新幹線",
    "jp-九州旅客鉄道-西九州新幹線",
  ]);

  // These are the operators' correct, current marks, but their artwork is
  // predominantly white because the official sites place it on a dark
  // header. Give only these assets a dark matte in the hover popup so the
  // original artwork stays legible in both app themes.
  const LOGOS_REQUIRING_DARK_MATTE = new Set([
    "/rail/operator-logos/jp-badges/badge-011.png",
    "/rail/operator-logos/jp/q7496602.png",
    "/rail/operator-logos/jp/q11657221.svg",
  ]);

  const OPERATOR_LOGOS = Object.freeze({
    MTR: "/rail/operator-logos/mtr-badge.png",
    澳門輕軌: "/rail/operator-logos/macao-lrt-badge.png",
    台鐵: "/rail/operator-logos/tra.svg",
    台灣高鐵: "/rail/operator-logos/thsr.svg",
    台北捷運: "/rail/operator-logos/trtc-badge.png",
    新北捷運: "/rail/operator-logos/ntmetro.svg",
    桃園捷運: "/rail/operator-logos/tym.png",
    台中捷運: "/rail/operator-logos/tcmrt.svg",
    高雄捷運: "/rail/operator-logos/krtc-badge.png",
    阿里山林鐵: "/rail/operator-logos/alsr-badge.png",
  });

  const LINE_LOGOS = Object.freeze({
    // Japanese lines whose package art was rejected (or missing) but which
    // publish an official line symbol of their own. Verified 2026-08-10:
    // 北勢線 carries the official 三岐鉄道 route letter H (the package art was
    // the pre-1944 北勢鉄道 predecessor mark); the 丸ノ内線 branch uses its
    // dedicated Mb identity rather than the trunk line's M symbol;
    // 京都市営地下鉄東西線 uses its official vermillion T symbol; 北海道
    // 新幹線 uses the JR Hokkaido Shinkansen pictogram supplied for this line.
    "jp-三岐鉄道-北勢線": "/rail/line-logos/sangi-hokusei.svg",
    "jp-東京地下鉄-4号線丸ノ内線分岐線":
      "/rail/line-logos/tokyo-metro-marunouchi-branch.svg",
    "jp-京都市-東西線": "/rail/line-logos/kyoto-tozai.svg",
    "jp-北海道旅客鉄道-北海道新幹線":
      "/rail/line-logos/hokkaido-shinkansen.svg",
    "tw-trtc-bl": "/rail/line-logos/trtc-bl.svg",
    "tw-trtc-r": "/rail/line-logos/trtc-r.svg",
    "tw-trtc-r-xinbeitou": "/rail/line-logos/trtc-r.svg",
    "tw-trtc-g": "/rail/line-logos/trtc-g.svg",
    "tw-trtc-g-xiaobitan": "/rail/line-logos/trtc-g.svg",
    "tw-trtc-o-luzhou": "/rail/line-logos/trtc-o.svg",
    "tw-trtc-o-huilong": "/rail/line-logos/trtc-o.svg",
    "tw-trtc-br": "/rail/line-logos/trtc-br.svg",
    "tw-trtc-y": "/rail/line-logos/ntmetro-y.svg",
    "tw-ntmetro-v-green": "/rail/line-logos/ntmetro-v.svg",
    "tw-ntmetro-v-blue": "/rail/line-logos/ntmetro-v.svg",
    "tw-ntmetro-k": "/rail/line-logos/ntmetro-k.svg",
    "tw-tym-a": "/rail/line-logos/tym-a.svg",
    "tw-tcmrt-g": "/rail/line-logos/tcmrt-g.svg",
    "tw-krtc-r": "/rail/line-logos/krtc-r.svg",
    "tw-krtc-o": "/rail/line-logos/krtc-o.svg",
    "tw-klrt-c": "/rail/line-logos/krtc-c.svg",
    "hk-mtr-lr-505": "/rail/line-logos/mtr-lr-505.svg",
    "hk-mtr-lr-507": "/rail/line-logos/mtr-lr-507.svg",
    "hk-mtr-lr-610": "/rail/line-logos/mtr-lr-610.svg",
    "hk-mtr-lr-614": "/rail/line-logos/mtr-lr-614.svg",
    "hk-mtr-lr-614p": "/rail/line-logos/mtr-lr-614p.svg",
    "hk-mtr-lr-615": "/rail/line-logos/mtr-lr-615.svg",
    "hk-mtr-lr-615p": "/rail/line-logos/mtr-lr-615p.svg",
    "hk-mtr-lr-705": "/rail/line-logos/mtr-lr-705.svg",
    "hk-mtr-lr-706": "/rail/line-logos/mtr-lr-706.svg",
    "hk-mtr-lr-751": "/rail/line-logos/mtr-lr-751.svg",
    "hk-mtr-lr-761p": "/rail/line-logos/mtr-lr-761p.svg",
  });

  function labelOne(name) {
    if (!name) return "";
    if (MACAO_COMPANY_LABELS[name]) return MACAO_COMPANY_LABELS[name];
    if (HONG_KONG_COMPANY_LABELS[name]) return HONG_KONG_COMPANY_LABELS[name];
    if (TAIWAN_COMPANY_LABELS[name]) return TAIWAN_COMPANY_LABELS[name];
    if (COMPANY_LABELS[name]) return COMPANY_LABELS[name];
    return name
      .replace(/(?:株式会社|有限会社)/g, "")
      .replace(/^(?:一般社団法人|一般財団法人|公益社団法人|公益財団法人|地方独立行政法人)/, "")
      .trim();
  }

  function companyLabel(operator) {
    return String(operator || "")
      .split("/")
      .map((name) => labelOne(name.trim()))
      .filter(Boolean)
      .join("/");
  }

  function normalizeTaiwanCompanyName(value) {
    return String(value || "")
      .split("/")
      .map((name) => {
        const trimmed = name.trim();
        return TAIWAN_COMPANY_LABELS[trimmed] || trimmed;
      })
      .filter(Boolean)
      .join("/");
  }

  function companyFor(operator, lineName) {
    const label = companyLabel(operator);
    if (!label) return "";
    if (String(lineName || "").startsWith(label)) return "";
    if (operator && String(lineName || "").startsWith(operator)) return "";
    return label;
  }

  function operatorLogo(operator) {
    const rawOperator = String(operator || "").trim();
    return (
      JAPAN_OPERATOR_BADGE_OVERRIDES[rawOperator] ||
      JAPAN_OPERATOR_LOGOS[rawOperator] ||
      JAPAN_PACKAGE_OPERATOR_LOGOS[rawOperator] ||
      OPERATOR_LOGOS[MACAO_COMPANY_LABELS[rawOperator]] ||
      OPERATOR_LOGOS[HONG_KONG_COMPANY_LABELS[rawOperator]] ||
      OPERATOR_LOGOS[normalizeTaiwanCompanyName(rawOperator)] ||
      null
    );
  }

  function lineLogo(lineId) {
    return LINE_LOGOS[lineId] || null;
  }

  function verifiedPackageLineLogo(line) {
    if (!line || !line.logo) return null;
    const lineId = String(line.lineId || line.id || "");
    if (lineId.startsWith("jp-") && JAPAN_NON_LINE_LOGO_IDS.has(lineId)) {
      return null;
    }
    return line.logo;
  }

  function logoForLine(line) {
    if (!line) return null;
    return (
      verifiedPackageLineLogo(line) ||
      lineLogo(line.lineId || line.id) ||
      operatorLogo(line.operator)
    );
  }

  function logoNeedsDarkMatte(logo) {
    return LOGOS_REQUIRING_DARK_MATTE.has(String(logo || ""));
  }

  return Object.freeze({
    companyLabel,
    normalizeTaiwanCompanyName,
    companyFor,
    operatorLogo,
    lineLogo,
    verifiedPackageLineLogo,
    logoForLine,
    logoNeedsDarkMatte,
  });
})();

window.RailOperatorBranding = RailOperatorBranding;
