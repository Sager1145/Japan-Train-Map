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

  // Company-level fallbacks for Japanese routes without a dedicated line
  // badge. Package-provided line.logo assets always win in logoForLine(), so
  // adding these does not alter any existing Japanese line identity.
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
    三陸鉄道: "/rail/operator-logos/jp/q7418928.png",
    上田電鉄: "/rail/operator-logos/jp/q11263296.svg",
    丹後海陸交通: "/rail/operator-logos/jp/q11368524.png",
    九州旅客鉄道: "/rail/operator-logos/jp/q498366.svg",
    京福電気鉄道: "/rail/operator-logos/jp/q3537126.svg",
    京都市: "/rail/operator-logos/jp/q5359594.svg",
    京阪電気鉄道: "/rail/operator-logos/jp/q1188274.svg",
    伊予鉄道: "/rail/operator-logos/jp/q3138970.svg",
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
    鹿児島市: "/rail/operator-logos/jp/q3537114.gif",
  });

  // These are the operators' correct, current marks, but their artwork is
  // predominantly white because the official sites place it on a dark
  // header. Give only these assets a dark matte in the hover popup so the
  // original artwork stays legible in both app themes.
  const LOGOS_REQUIRING_DARK_MATTE = new Set([
    "/rail/operator-logos/jp/seikan-tunnel-museum.png",
    "/rail/operator-logos/jp/q7496602.png",
    "/rail/operator-logos/jp/q11650435.png",
    "/rail/operator-logos/jp/q11657221.svg",
  ]);

  const OPERATOR_LOGOS = Object.freeze({
    台鐵: "/rail/operator-logos/tra.svg",
    台灣高鐵: "/rail/operator-logos/thsr.svg",
    台北捷運: "/rail/operator-logos/trtc.svg",
    新北捷運: "/rail/operator-logos/ntmetro.svg",
    桃園捷運: "/rail/operator-logos/tym.png",
    台中捷運: "/rail/operator-logos/tcmrt.svg",
    高雄捷運: "/rail/operator-logos/krtc.svg",
    阿里山林鐵: "/rail/operator-logos/alsr.svg",
  });

  const LINE_LOGOS = Object.freeze({
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
  });

  function labelOne(name) {
    if (!name) return "";
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
      JAPAN_OPERATOR_LOGOS[rawOperator] ||
      OPERATOR_LOGOS[normalizeTaiwanCompanyName(rawOperator)] ||
      null
    );
  }

  function lineLogo(lineId) {
    return LINE_LOGOS[lineId] || null;
  }

  function logoForLine(line) {
    if (!line) return null;
    return line.logo || lineLogo(line.lineId || line.id) || operatorLogo(line.operator);
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
    logoForLine,
    logoNeedsDarkMatte,
  });
})();

window.RailOperatorBranding = RailOperatorBranding;
