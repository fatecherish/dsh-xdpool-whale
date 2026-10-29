"""
从 assets/originals/DSniang02.png 裁出「思考鲸鱼」的纯立绘 assets/DSniang03.png。

为什么需要这一步：源图是一整幅构图——左上角一个白色思考气泡（含两个虚线小泡泡），
右下角才是人物。挂件本身用 SVG 画气泡，如果把整图当立绘塞进去，会变成
「图里自带的白气泡 + SVG 气泡」两层叠在一起，人物只剩右下角一截。

所以这里把气泡整块抠掉，只留人物，并输出成和 whale.png 同规格的画布：
512x512、透明底、人物底部对齐、水平居中——这样两套皮肤可以共用同一套
`.xdw-whale` 定位（坐在气泡右下角），不需要任何按皮肤区分的 CSS。

裁切依据（对 1026x1026 源图逐像素扫描得到，不是手调的）：
  - y <  514：全部是气泡主体（描边 + 内部空白），整段清空
  - y >= 514：有 3 个不透明连通块，最大那个（约 236k 像素）是人物，
              另外两个（约 5.4k / 2.8k 像素）是虚线小泡泡，清掉

用法：
    python scripts/crop-art2.py            # 重新生成 assets/DSniang03.png
    python scripts/crop-art2.py --check    # 只检查现有文件是否与重新生成的结果一致

依赖：Pillow（本机已装 12.x）。
"""
import sys
from collections import deque
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境缺依赖时的明确提示
    sys.exit("需要 Pillow：pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "originals" / "DSniang02.png"
OUT = ROOT / "assets" / "DSniang03.png"

# 气泡主体描边的下边界：这一行以上全是气泡，以下只剩人物与虚线小泡泡
BUBBLE_BOTTOM = 514

# 输出画布规格，与 assets/whale.png 保持一致
SIZE = 512
# 人物占画布的比例：宽最多 94%、高最多 96%，底部对齐
MAX_W_RATIO = 0.94
MAX_H_RATIO = 0.96

# alpha 低于这个值当作完全透明（抗锯齿边缘不算实体）
ALPHA_MIN = 40


def build():
    """按上面的规则裁出纯立绘，返回 PIL Image（512x512 RGBA）。"""
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    px = im.load()

    # 1) 清掉气泡主体
    for y in range(0, BUBBLE_BOTTOM):
        for x in range(w):
            if px[x, y][3] > 0:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)

    # 2) 找剩余的所有连通块，最大的留下，其余（虚线小泡泡）清掉
    seen = set()
    blobs = []
    for y0 in range(BUBBLE_BOTTOM, h):
        for x0 in range(w):
            if (x0, y0) in seen or px[x0, y0][3] <= ALPHA_MIN:
                continue
            q = deque([(x0, y0)])
            seen.add((x0, y0))
            minx = maxx = x0
            miny = maxy = y0
            count = 0
            while q:
                x, y = q.popleft()
                count += 1
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if (
                            0 <= nx < w
                            and BUBBLE_BOTTOM <= ny < h
                            and (nx, ny) not in seen
                            and px[nx, ny][3] > ALPHA_MIN
                        ):
                            seen.add((nx, ny))
                            q.append((nx, ny))
            blobs.append((count, minx, maxx, miny, maxy))

    if not blobs:
        sys.exit(f"在 {SRC} 的 y>={BUBBLE_BOTTOM} 区域找不到任何不透明像素，源图可能换了")

    blobs.sort(reverse=True)
    _, minx, maxx, miny, maxy = blobs[0]
    for count, bx0, bx1, by0, by1 in blobs[1:]:
        for y in range(by0, by1 + 1):
            for x in range(bx0, bx1 + 1):
                if px[x, y][3] > 0:
                    r, g, b, _ = px[x, y]
                    px[x, y] = (r, g, b, 0)

    cw = maxx - minx + 1
    ch = maxy - miny + 1

    # 3) 裁出人物，按比例缩放后贴到方形画布底部
    person = im.crop((minx, miny, maxx + 1, maxy + 1))
    scale = min((SIZE * MAX_W_RATIO) / cw, (SIZE * MAX_H_RATIO) / ch)
    nw, nh = int(cw * scale), int(ch * scale)
    person = person.resize((nw, nh), Image.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(person, ((SIZE - nw) // 2, SIZE - nh), person)
    return canvas


def main():
    check = "--check" in sys.argv
    canvas = build()

    if check:
        if not OUT.exists():
            sys.exit(f"MISSING: {OUT} 不存在")
        current = Image.open(OUT).convert("RGBA")
        if current.size != canvas.size or current.tobytes() != canvas.tobytes():
            sys.exit(
                f"STALE: {OUT.name} 与 scripts/crop-art2.py 重新生成的结果不一致，"
                "请运行 python scripts/crop-art2.py 重新生成"
            )
        print(f"  OK   assets/{OUT.name} 与裁切脚本一致（{canvas.size[0]}x{canvas.size[1]}）")
        return

    canvas.save(OUT, "PNG", optimize=True)
    print(f"已写出 assets/{OUT.name}（{canvas.size[0]}x{canvas.size[1]}，{OUT.stat().st_size} 字节）")


if __name__ == "__main__":
    main()
