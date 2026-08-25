import sqlite3
import datetime

c = sqlite3.connect("data/app.db")
c.row_factory = sqlite3.Row

print("slicks per scene:")
for r in c.execute("SELECT scene_name, COUNT(*) n, MIN(detected_at) d FROM slicks GROUP BY scene_name"):
    ts = datetime.datetime.utcfromtimestamp(r["d"]).strftime("%m-%d %H:%M")
    print(f"  {r['scene_name'][:48]} | {r['n']} slicks | sensed {ts}")

print()
for r in c.execute("SELECT id,scene_name,detected_at,confidence FROM slicks WHERE id IN (18,20,21)"):
    ts = datetime.datetime.utcfromtimestamp(r["detected_at"]).strftime("%m-%d %H:%M")
    print(f"slick {r['id']}: scene {r['scene_name'][:44]} sensed {ts} conf {r['confidence']}")

print()
print("suspects by slick:")
for r in c.execute("SELECT slick_id, COUNT(*) n, MAX(score) mx FROM suspects GROUP BY slick_id"):
    print(f"  slick {r['slick_id']}: {r['n']} suspects, top score {r['mx']:.0f}")

print()
print("top suspects overall:")
for r in c.execute(
        "SELECT s.slick_id, s.mmsi, s.score, s.rank, v.name FROM suspects s "
        "LEFT JOIN vessels v ON v.mmsi=s.mmsi ORDER BY s.score DESC LIMIT 8"):
    print(f"  slick {r['slick_id']} rank{r['rank']} mmsi {r['mmsi']} "
          f"score {r['score']:.0f} name {r['name']}")
