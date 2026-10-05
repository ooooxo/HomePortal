#!/usr/bin/env python3
# 生成对照版：把现行 public/index.html 原文注入 portal-ice.src.html，产出 portal-ice.html（第 0 档 = 真现状）。
# 跑法：python3 docs/lab/build.py   （在 HomePortal 仓库根或任意目录都行）
# 需要：python3；无第三方依赖。
import json
from pathlib import Path

LAB = Path(__file__).resolve().parent
ROOT = LAB.parent.parent
SRC = LAB / "portal-ice.src.html"
OUT = LAB / "portal-ice.html"
CURRENT = ROOT / "public" / "index.html"

current = CURRENT.read_text(encoding="utf-8")
# 内嵌进 <script> 里的字符串不能出现 </script>，拆开写
payload = json.dumps(current, ensure_ascii=False).replace("</script", "<\\/script")
OUT.write_text(SRC.read_text(encoding="utf-8").replace('/*__CURRENT_HTML__*/""', payload), encoding="utf-8")
print(OUT)
