# 東京特急大回り行程：资料依据

日期按第一张 TripIt 预订截图所示的“5 月 29 日、星期五”，结合当前行程上下文记为 2026-05-29。八个预订区间的起终点与到发时间以第一张截图为准；第二张表只用于补齐未预订的普通列车衔接和列车名。

末段按用户的实际修改处理：不再乘梓 50 号到千叶，而是在该特急到千叶前的停站船桥下车（20:38），再乘中央・总武线各站停车 1904Y（船桥 20:41）到西千叶（21:00）。西千叶是该普通列车抵达千叶前的最后一站。

- [JR 東日本：総武本線・成田線 下り時刻表（しおさい1号の通過表示を含む）](https://timetables.jreast.co.jp/2608/timetable-v/213d1.html)
- [JR 東日本：わかしお10号停車駅一覧](https://timetables.jreast.co.jp/2607/train/045/049571.html)
- [JR 東日本：ひたち・常磐線 上り時刻表](https://timetables.jreast.co.jp/2608/timetable-v/240u2.html)
- [JR 東日本：踊り子9号停車駅一覧](https://timetables.jreast.co.jp/2607/train/095/099141.html)
- [JR 東日本：かいじ32号停車駅一覧](https://timetables.jreast.co.jp/2608/train/060/063621.html)
- [JR 東日本：高崎線・上越線 上り時刻表（草津・四万4号）](https://timetables.jreast.co.jp/2608/timetable-v/238u1p.html)
- [JR 東日本：東武日光線 上り時刻表（スペーシア日光4号）](https://timetables.jreast.co.jp/2607/timetable-v/699u2p.html)
- [JR 東日本：あずさ50号停車駅一覧](https://timetables.jreast.co.jp/2607/train/060/063801.html)
- [JR 東日本：中央・総武線各駅停車 平日時刻表](https://timetables.jreast.co.jp/2607/timetable-v/659u1p.html)

路线几何使用国土数值情報 N02-25 的正式物理线名。例如埼京线区间使用 N02 的「東北線」，浦和—新宿的直通特急使用「東北線」「赤羽線」「山手線」。

生成数据按 JSON spec 只保留实际乘坐区间。每段实际物理线路上的 N02 站均写入 `stops`；官方表列出的停车站使用 `passenger_stop`，表中「レ」或未列为停站的中间站使用 `pass_through`。官方停站表给出中间站到发时刻时一并写入；普通列车没有逐站时刻依据的中间站保留 `null`，不做估算。跨线列车在实际换线站拆分 `route_sections`，每个相邻站区间都带精确 `line_names` 和 JR 东日本 N02 运营者名。
