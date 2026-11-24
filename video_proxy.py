"""
疏影拾知 · 本地代理（视频解析 + 音频转写）
-------------------------------------------------------------
为浏览器前端提供以下能力：
  ① /fetch?url=...            —— 通用 HTTP 转发（解 CORS）
  ② /yt-dlp?url=...           —— 本地 yt-dlp 视频元数据解析
  ③ POST /backend-parse       —— 转发到免费聚合视频 API（jiejing.fun）
  ④ POST /transcribe          —— Whisper 本地音频转写（上传 base64 音频 → 返回文本）
  ⑤ /health                   —— 环境检测（yt-dlp / whisper / ffmpeg）

依赖（可选，装了才生效）：
    pip install openai-whisper    # 音频转写（需要 ffmpeg + torch）
    pip install yt-dlp            # 视频解析
    或 winget install ffmpeg     # Whisper 必需

用法：
    cd d:\大三上课程\web\期末
    python video_proxy.py
"""

import json
import urllib.request
import urllib.parse
import subprocess
import sys
import shutil
import re
import os
import tempfile
import base64
import uuid
import threading
import time
import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Whisper 在 anaconda 环境下会触发 OpenMP 双重初始化冲突，需要这个环境变量绕过
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

PORT = 5600

# B 站 API 有风控：必须带 UA + Referer，否则返回 -412
REQUEST_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Referer": "https://www.bilibili.com/",
}

# 免费第三方聚合解析 API（返回 JSON，支持抖音/小红书/B站/YouTube/Instagram 等 20+ 平台）
# 文档：https://qsy.jiejing.fun/api-doc
THIRD_PARTY_PARSE = "https://a.jiejing.fun/parse"

# 检测 yt-dlp 是否可用
YTDLP = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")

# 检测 whisper（本地 ASR）
try:
    import whisper
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    whisper = None

# 检测 zhconv（繁体→简体转换）
try:
    import zhconv
    ZHCONV_AVAILABLE = True
except ImportError:
    ZHCONV_AVAILABLE = False
    zhconv = None

# Whisper 模型全局缓存 + 双重检查锁（首次加载，后续请求直接复用，避免每次都重新加载）
_WHISPER_MODEL_CACHE = {}
_TRANSCRIBE_LOCK = threading.Lock()


def _load_whisper_model(model_size):
    """加载并缓存 Whisper 模型：同一 size 只加载一次"""
    if model_size not in _WHISPER_MODEL_CACHE:
        with _TRANSCRIBE_LOCK:
            if model_size not in _WHISPER_MODEL_CACHE:
                print(f"[init] 首次加载 Whisper {model_size} 模型（后续请求直接复用缓存）...")
                _WHISPER_MODEL_CACHE[model_size] = whisper.load_model(model_size)
                print(f"[init] Whisper {model_size} 模型加载完成")
    return _WHISPER_MODEL_CACHE[model_size]


def _pick_whisper_model():
    """按本地已有模型文件选择转写模型：base > tiny > small"""
    base_cache = os.path.expanduser("~/.cache/whisper/base.pt")
    tiny_cache = os.path.expanduser("~/.cache/whisper/tiny.pt")
    if os.path.exists(base_cache) and os.path.getsize(base_cache) > 10_000_000:
        return "base"
    if os.path.exists(tiny_cache) and os.path.getsize(tiny_cache) > 10_000_000:
        return "tiny"
    return "small"


def _clean_asr_text(text, initial_prompt=""):
    """中文 ASR 后处理：prompt 泄漏清理 → 重复/乱码清理 → 合并空白"""
    if not text:
        return ""
    for p in ["请使用简体中文输出", "保持标点清晰", "以下是一段课堂录音转写",
              "内容包含中文普通话", initial_prompt]:
        if p:
            text = text.replace(p, "").strip()
    text = re.sub(r'(.)\1{3,}', r'\1\1\1', text)          # 重复汉字
    text = re.sub(r'\s+[a-zA-Z]{1,2}\s+', ' ', text)      # 孤立英文碎片
    text = re.sub(r'[，。！？、；：]{2,}', lambda m: m.group()[0], text)
    text = re.sub(r'。，', '。', text)
    # 去掉句首残留的 prompt 关键词碎片（如「课堂录音，简体中文，」）
    text = re.sub(r'^(?:(?:课堂录音|简体中文|专业术语|技术名词|普通话)[，,、\s]*)+', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip('，。！？、；：,.!? ')


def _audio_file_to_text(src_path):
    """任意音频文件 → 16kHz 单声道 WAV → Whisper → 清理 + 繁体转简体"""
    wav_path = os.path.join(tempfile.gettempdir(), f"syzz_{uuid.uuid4().hex}.wav")
    try:
        subprocess.run(
            [FFMPEG, "-y", "-i", src_path, "-vn",
             "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_path],
            check=True, capture_output=True, timeout=600
        )
        model_size = _pick_whisper_model()
        print(f"[video-transcribe] 使用 Whisper {model_size} 转写 ...")
        model = _load_whisper_model(model_size)
        initial_prompt = "课堂录音，简体中文，专业术语，技术名词。"
        with _TRANSCRIBE_LOCK:
            result = model.transcribe(
                wav_path, language="zh", fp16=False,
                initial_prompt=initial_prompt, verbose=False,
                condition_on_previous_text=False,
                temperature=[0.0, 0.2, 0.4],
                no_speech_threshold=0.6, beam_size=5, best_of=5,
            )
        text = _clean_asr_text(result.get("text", ""), initial_prompt)
        if ZHCONV_AVAILABLE:
            text = zhconv.convert(text, "zh-cn")
        return {"text": text, "model": model_size}
    finally:
        try: os.remove(wav_path)
        except: pass


def _humanize_ytdlp_error(stderr_text):
    """把 yt-dlp 报错翻译成用户能看懂的提示"""
    low = (stderr_text or "").lower()
    if "login" in low or "cookie" in low or "premium" in low or "members" in low or "大会员" in stderr_text:
        return "该视频需要登录或开通会员后才能获取音轨（受版权/权限限制），请粘贴字幕文稿完成解析"
    if "drm" in low or "encrypted" in low:
        return "该视频受 DRM 加密保护，无法提取音轨，请粘贴字幕文稿完成解析"
    if "unsupported url" in low or "no suitable" in low:
        return "该平台暂不支持自动提取音轨，请粘贴字幕文稿完成解析"
    if "timed out" in low or "timeout" in low:
        return "音轨下载超时，请稍后重试或粘贴字幕文稿完成解析"
    return "无法获取该视频音轨（可能需要登录 / 会员 / 平台限制），请粘贴字幕文稿完成解析"


# ============================================================
# 本地大模型调度器（ollama）：文本清洗 / 错别字校正 / 摘要生成
#   调度顺序：Qwen3.8-Max（优先）→ DeepSeek-V4.1-Flash（回退）
#             → 本地已安装的任意可用模型（兜底，保证链路不宕机）
# ============================================================
OLLAMA_ROOT = "http://127.0.0.1:11434"
LLM_PREFERRED = ["qwen3.8-max", "qwen3.8max", "qwen3-max", "qwen2.5:3b", "qwen2.5"]
# 本地回退顺序：小模型优先（CPU 机器上 8b 推理过慢，1.5b 保证响应速度）
LLM_LOCAL_FALLBACK = ["deepseek-v4.1-flash", "deepseek-r1:1.5b", "deepseek-r1:8b"]

_OLLAMA_MODELS_CACHE = {"names": None, "ts": 0.0}


def _ollama_available():
    """检测 ollama 服务可用模型列表（缓存 60 秒）"""
    if _OLLAMA_MODELS_CACHE["names"] is not None and time.time() - _OLLAMA_MODELS_CACHE["ts"] < 60:
        return _OLLAMA_MODELS_CACHE["names"]
    try:
        with urllib.request.urlopen(OLLAMA_ROOT + "/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        names = [m.get("name", "") for m in data.get("models", [])]
    except Exception:
        names = []
    _OLLAMA_MODELS_CACHE["names"] = names
    _OLLAMA_MODELS_CACHE["ts"] = time.time()
    return names


def _llm_candidates():
    """返回有序候选模型列表：Qwen 优先 → DeepSeek 回退 → 其余本地模型兜底"""
    names = _ollama_available()
    if not names:
        return []
    lowered = {n.lower(): n for n in names}
    cands = []

    def _push(prefix):
        key = prefix.lower()
        if key in lowered and lowered[key] not in cands:
            cands.append(lowered[key])
            return True
        base = key.split(":")[0]
        for low, orig in lowered.items():
            if (low == base or low.startswith(base + ":")) and orig not in cands:
                cands.append(orig)
                return True
        return False

    for pref in LLM_PREFERRED:
        _push(pref)
    for fb in LLM_LOCAL_FALLBACK:
        _push(fb)
    # 兜底：任何本地已装模型都可用，保证 AI 链路不直接宕机
    for n in names:
        if n not in cands:
            cands.append(n)
    return cands


def _strip_think(text):
    """剥离推理模型的思考块（<think>/ <think> 等变体），只保留最终回答"""
    text = text or ""
    text = re.sub(r"<think[^>]*>.*?</think[^>]*>", "", text, flags=re.S)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    # 思考块未闭合（被长度截断）：整段视为无效，返回空让调度器切换下一模型
    OPEN = "<" + "think"
    CLOSE = "</" + "think"
    if OPEN in text and CLOSE not in text:
        return ""
    idx = text.rfind(CLOSE)
    if idx != -1:
        rest = text[idx + len(CLOSE):]
        m = re.match(r"[^>]*>", rest)   # 跳过闭合标签残留部分
        text = rest[m.end():] if m else rest
    text = re.sub(r"</?think[^>]*>", "", text)
    return text.strip()


def _llm_chat(model, prompt, max_tokens=600, timeout=240):
    """调用 ollama /api/chat（非流式），失败抛异常"""
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.3, "num_predict": max_tokens},
    }).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_ROOT + "/api/chat", data=payload,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    content = (data.get("message") or {}).get("content", "")
    return _strip_think(content)


SUMMARIZE_PROMPT = """你是大学课堂笔记整理助手。下面是原始素材（课堂录音转写 / 视频简介文案），可能含口语、错别字、推广废话。
要求：
1. 纠正错别字与口语表达，改写为简洁准确的简体中文；
2. 提炼 3-6 条核心知识点，每条一行，格式为「1. xxx」；
3. 最后一行输出「概要：xxx」（50 字以内）；
4. 只输出以上内容，不要解释、不要标题、不要 markdown 代码块。
原始素材：
{text}"""


def _llm_summarize(text):
    """模型调度摘要：按候选顺序逐个尝试，任一成功即返回；全部失败抛异常"""
    candidates = _llm_candidates()
    if not candidates:
        raise RuntimeError("ollama 服务不可用或无已安装模型")
    prompt = SUMMARIZE_PROMPT.format(text=text[:6000])
    last_err = None
    for cand in candidates:
        try:
            print(f"[summarize] 调度模型 {cand} ...")
            out = _llm_chat(cand, prompt, max_tokens=1024)
            if out and len(out) >= 10:
                print(f"[summarize] {cand} 成功: {out[:60]}...")
                return {"text": out, "model": cand}
            last_err = RuntimeError(f"{cand} 返回空内容")
        except Exception as e:
            last_err = e
            print(f"[summarize] {cand} 失败: {str(e)[:120]}")
    raise last_err or RuntimeError("全部模型失败")

# 检测 ffmpeg（whisper 音频解码必需）
# 优先级：shutil.which → imageio-ffmpeg（pip 装） → None
FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    try:
        import imageio_ffmpeg
        FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        FFMPEG = None

# Whisper 内部 subprocess 调 ffmpeg，需要 PATH 能找到它
if FFMPEG:
    _ffmpeg_dir = os.path.dirname(FFMPEG)
    _base_name = os.path.basename(FFMPEG).lower()
    # 如果二进制名不是 "ffmpeg.exe"（如 imageio-ffmpeg 叫 ffmpeg-win-x86_64-v9.0.2.exe），
    # 在同目录复制一份 "ffmpeg.exe" 供 whisper 子进程调用
    if _base_name != "ffmpeg.exe":
        _symlink = os.path.join(_ffmpeg_dir, "ffmpeg.exe")
        if not os.path.exists(_symlink):
            try:
                import shutil as _sh
                _sh.copy2(FFMPEG, _symlink)
                print(f"[init] 创建 ffmpeg.exe 副本: {_symlink}")
            except Exception as _e:
                print(f"[init] 创建 ffmpeg.exe 副本失败（可忽略）: {_e}")
    _cur_path = os.environ.get("PATH", "")
    if _ffmpeg_dir not in _cur_path:
        os.environ["PATH"] = _cur_path + os.pathsep + _ffmpeg_dir
    # 更新 FFMPEG 为标准名，供我们自己的代码用
    FFMPEG = os.path.join(_ffmpeg_dir, "ffmpeg.exe")


class ProxyHandler(BaseHTTPRequestHandler):

    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, *")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/health":
            self._respond(200, {
                "ok": True,
                "yt_dlp": bool(YTDLP),
                "whisper": WHISPER_AVAILABLE,
                "ffmpeg": bool(FFMPEG),
                "msg": "本地代理运行中"
            })
            return

        # ① 通用 HTTP 转发
        if parsed.path == "/fetch":
            self._handle_fetch(parsed)
            return

        # ② 本地 yt-dlp 解析（全平台最稳）
        if parsed.path == "/yt-dlp":
            self._handle_ytdlp(parsed)
            return

        self._respond(404, {"ok": False, "error": "未知路径"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        # ③ 第三方聚合 API 转发
        if parsed.path == "/backend-parse":
            self._handle_backend_parse()
            return

        # ④ 本地 Whisper 音频转写（上传 base64 → 返回文本）
        if parsed.path == "/transcribe":
            self._handle_transcribe()
            return

        # ⑤ 本地大模型 AI 提炼（Qwen 优先 / DeepSeek 回退）
        if parsed.path == "/summarize":
            self._handle_summarize()
            return

        # ⑥ 视频链接 → 下载音轨 → Whisper 转写（全自动解析）
        if parsed.path == "/video-transcribe":
            self._handle_video_transcribe()
            return

        self._respond(404, {"ok": False, "error": "未知路径"})

    # ============ 通用 HTTP 转发 ============
    def _handle_fetch(self, parsed):
        try:
            qs = urllib.parse.parse_qs(parsed.query)
            target = (qs.get("url") or [""])[0]
            if not target.startswith(("http://", "https://")):
                raise ValueError("缺少合法的 url 参数")

            req = urllib.request.Request(target, headers=REQUEST_HEADERS)
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self._set_cors()
                ctype = resp.headers.get("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Type", ctype)
                self.end_headers()
                self.wfile.write(body)
            print(f"[fetch] {target[:80]}")
        except Exception as e:
            self._respond(502, {"ok": False, "error": str(e)})
            print(f"[fetch FAIL] {self.path[:80]} -> {e}")

    # ============ 本地 yt-dlp 解析 ============
    def _handle_ytdlp(self, parsed):
        if not YTDLP:
            self._respond(501, {"ok": False, "error": "yt-dlp 未安装，执行 pip install yt-dlp"})
            return
        try:
            qs = urllib.parse.parse_qs(parsed.query)
            url = (qs.get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                raise ValueError("缺少合法的 url 参数")

            # subprocess 调 yt-dlp：只拿元数据 JSON，不下载视频
            result = subprocess.run(
                [YTDLP, "-j", "--skip-download", "--no-playlist", "--no-warnings", url],
                capture_output=True, text=True, timeout=30,
                encoding="utf-8", errors="replace"
            )
            if result.returncode != 0:
                err = (result.stderr or result.stdout or "yt-dlp 解析失败").strip()
                self._respond(502, {"ok": False, "error": err[:300]})
                print(f"[yt-dlp FAIL] {url[:60]} -> {err[:100]}")
                return

            raw = json.loads(result.stdout)
            # 规范化成统一结构
            data = {
                "title": raw.get("title", ""),
                "description": raw.get("description", "") or "",
                "uploader": raw.get("uploader", "") or raw.get("channel", ""),
                "duration": raw.get("duration"),
                "view_count": raw.get("view_count"),
                "like_count": raw.get("like_count"),
                "tags": raw.get("tags", []),
                "categories": raw.get("categories", []),
                "webpage_url": raw.get("webpage_url", url),
                "thumbnail": raw.get("thumbnail", ""),
                "extractor": raw.get("extractor", ""),
            }
            self._respond(200, {"ok": True, "source": "yt-dlp", "data": data})
            print(f"[yt-dlp OK] {url[:60]} -> {data['title'][:40]}")
        except subprocess.TimeoutExpired:
            self._respond(504, {"ok": False, "error": "yt-dlp 执行超时"})
        except Exception as e:
            self._respond(502, {"ok": False, "error": str(e)[:300]})
            print(f"[yt-dlp ERR] {self.path[:60]} -> {e}")

    # ============ 第三方聚合 API 转发 ============
    def _handle_backend_parse(self):
        try:
            # 读 POST body
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(body)
            target_url = (payload.get("url") or "").strip()

            if not target_url.startswith(("http://", "https://")):
                raise ValueError("缺少合法的 url 参数")

            # 发 POST 给聚合 API
            req_data = json.dumps({"url": target_url}).encode("utf-8")
            req = urllib.request.Request(
                THIRD_PARTY_PARSE,
                data=req_data,
                headers={**REQUEST_HEADERS, "Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            # 规范化：不同 API 返回结构不同，兼容处理
            normalized = self._normalize_third_party(result, target_url)
            self._respond(200, {"ok": True, "source": "third-party", "data": normalized, "raw": result})
            print(f"[backend-parse OK] {target_url[:60]} -> {normalized.get('title','')[:40]}")
        except Exception as e:
            self._respond(502, {"ok": False, "error": str(e)[:300]})
            print(f"[backend-parse FAIL] {self.path[:60]} -> {e}")

    def _normalize_third_party(self, raw, url):
        """把不同第三方 API 的返回统一成 {title, description, author, tags, webpage_url} 格式"""
        body = raw.get("body") or raw.get("data") or {}

        title = body.get("title") or ""
        # 清理标题里混进来的"作者:"尾巴
        title = re.sub(r'\n作者[:：].*$', '', title).strip()

        description = body.get("desc") or body.get("description") or ""
        author = body.get("author") or body.get("uploader") or ""

        # 从标题里抽 #hashtag 当 tags
        tags = re.findall(r'#(\S+)', (body.get("title") or "") + " " + description)

        return {
            "title": title,
            "description": description,
            "author": author,
            "tags": tags[:10],
            "webpage_url": url,
            "cover_url": body.get("cover_url") or body.get("cover") or "",
        }

    # ============ Whisper 音频转写 ============
    def _handle_transcribe(self):
        """
        接收 JSON { filename, mimeType, data(base64) }
        用 Whisper 本地转写，返回 { ok, text, segments }
        """
        # 1. 检查依赖
        if not WHISPER_AVAILABLE:
            self._respond(501, {
                "ok": False,
                "error": "Whisper 未安装。执行:\n  pip install openai-whisper\n  winget install ffmpeg"
            })
            return
        if not FFMPEG:
            self._respond(501, {
                "ok": False,
                "error": "ffmpeg 未找到（Whisper 必需）。执行:\n  winget install ffmpeg"
            })
            return

        try:
            # 2. 读请求体
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw)
            filename = payload.get("filename") or "audio"
            b64_data = payload.get("data", "")

            if not b64_data:
                raise ValueError("缺少音频数据（base64）")

            # 3. base64 → 临时文件
            audio_bytes = base64.b64decode(b64_data)
            ext = os.path.splitext(filename)[1] or ".mp3"
            tmp_path = os.path.join(tempfile.gettempdir(), f"syzz_{uuid.uuid4().hex}{ext}")
            with open(tmp_path, "wb") as f:
                f.write(audio_bytes)
            print(f"[transcribe] 接收音频: {filename} ({len(audio_bytes)} bytes) → {tmp_path}")

            # 3.1 ffmpeg 统一转码为 16kHz 单声道 WAV
            # 先探测文件 codec（用 ffprobe 或 ffmpeg -i），判断是否为已知可解码格式
            wav_path = os.path.join(tempfile.gettempdir(), f"syzz_{uuid.uuid4().hex}.wav")

            # --- 探测文件编码 ---
            codec_label = "unknown"
            codec_fourcc = ""
            try:
                # ffmpeg -i 会打印 Input 信息，我们从中提取 Audio codec 名
                probe = subprocess.run(
                    [FFMPEG, "-i", tmp_path],
                    capture_output=True, timeout=15
                )
                probe_text = probe.stderr.decode(errors="ignore").lower()
                # 找 "audio: xxx" 这行的 codec 名
                import re as _re
                m = _re.search(r'audio:\s+(\S+)\s+\(', probe_text)
                if m:
                    codec_label = m.group(1)  # 比如 "alac", "aac", "none"
                # 也找 FourCC (alac / mp4a / none)
                m2 = _re.search(r'\((\w{4})\s*/\s*0x', probe_text)
                if m2:
                    codec_fourcc = m2.group(1)
                print(f"[transcribe] 探测 codec: label={codec_label}, fourcc={codec_fourcc}")
            except Exception as e:
                print(f"[transcribe] codec 探测异常: {e}")

            # 明确已知不可解码的格式 → 直接拒绝
            # 只有 codec label 为 none/空 才是真的认不出；fourcc 为空是正常的（WAV/MP3 无 FourCC）
            UNDECODABLE_LABELS = {"none", ""}
            UNDECODABLE_FOURCC = {"0x00000000"}  # 只有全零才是坏的
            if codec_label in UNDECODABLE_LABELS or codec_fourcc in UNDECODABLE_FOURCC:
                self._respond(415, {
                    "ok": False,
                    "error": (
                        "音频格式无法识别（可能是加密或私有格式）。\n"
                        "建议：请用免费软件将文件转换为 MP3/WAV 后再上传。\n"
                        "推荐工具：格式工厂 / 在线音频转换网站。"
                    ),
                    "detail": f"ffmpeg 识别为: Audio={codec_label} ({codec_fourcc})",
                })
                try: os.remove(tmp_path)
                except: pass
                return

            # --- 统一转码 ---
            try:
                subprocess.run(
                    [FFMPEG, "-y", "-i", tmp_path,
                     "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_path],
                    check=True, capture_output=True, timeout=300
                )
                whisper_input = wav_path
                print(f"[transcribe] ffmpeg 转码完成: {os.path.getsize(wav_path)} bytes")
                try: os.remove(tmp_path)
                except: pass
            except subprocess.CalledProcessError as e:
                stderr_text = e.stderr.decode(errors="ignore") if e.stderr else ""
                print(f"[transcribe] ffmpeg 转码失败 (exit {e.returncode}), stderr: {stderr_text[:150]}")
                # 不可解码关键词兜底
                undecodable_kw = ["no decoder", "unknown codec", "could not find codec",
                                  "codec parameters", "audio: none", "invalid argument"]
                if any(kw in stderr_text.lower() for kw in undecodable_kw):
                    self._respond(415, {
                        "ok": False,
                        "error": (
                            f"音频格式无法识别（codec: {codec_label}）。\n"
                            "建议：转换为 MP3/WAV 后再上传。"
                        ),
                        "detail": stderr_text[:200],
                    })
                else:
                    self._respond(400, {
                        "ok": False, "error": f"音频文件损坏或无法解码，请换一个试试。",
                        "detail": stderr_text[:200],
                    })
                try: os.remove(tmp_path); os.remove(wav_path)
                except: pass
                return
            except Exception as e:
                self._respond(500, {"ok": False, "error": f"音频转码异常: {str(e)[:200]}"})
                try: os.remove(tmp_path); os.remove(wav_path)
                except: pass
                return

            # 4. Whisper 转写（ffmpeg 已保证输入是 16kHz mono WAV，应该不会崩，但加层保护）
            # 模型优先级：base > tiny
            base_cache = os.path.expanduser("~/.cache/whisper/base.pt")
            tiny_cache = os.path.expanduser("~/.cache/whisper/tiny.pt")
            if os.path.exists(base_cache) and os.path.getsize(base_cache) > 10_000_000:
                model_size = "base"
            elif os.path.exists(tiny_cache) and os.path.getsize(tiny_cache) > 10_000_000:
                model_size = "tiny"
            else:
                model_size = "small"

            print(f"[transcribe] 使用 Whisper {model_size} 模型...")
            model = _load_whisper_model(model_size)

            # initial_prompt 用关键词列表形式，降低被 Whisper 抄进输出的概率
            initial_prompt = "课堂录音，简体中文，专业术语，技术名词。"
            try:
                with _TRANSCRIBE_LOCK:  # 串行转写，避免并发请求抢占 GPU/内存
                    result = model.transcribe(
                        whisper_input,
                        language="zh",
                        fp16=False,
                        initial_prompt=initial_prompt,
                        verbose=False,
                        condition_on_previous_text=False,
                        temperature=[0.0, 0.2, 0.4],
                        no_speech_threshold=0.6,
                        beam_size=5,
                        best_of=5,
                    )
            except Exception as e:
                print(f"[transcribe] Whisper transcribe 崩溃: {e}")
                self._respond(500, {
                    "ok": False,
                    "error": f"Whisper 转写失败: {str(e)[:200]}\n请尝试下载 MP3/WAV 格式的音频文件。",
                })
                try: os.remove(wav_path); os.remove(whisper_input)
                except: pass
                return

            # 4.1 中文后处理（三层清理）
            def _clean_chinese(text):
                if not text:
                    return text
                import re as _re

                # ---- 第一层：清理 prompt 泄漏 ----
                # Whisper 偶尔会把 initial_prompt 原封不动抄到输出里
                prompt_phrases = [
                    "请使用简体中文输出",
                    "保持标点清晰",
                    "以下是一段课堂录音转写",
                    "内容包含中文普通话",
                    initial_prompt,
                ]
                for p in prompt_phrases:
                    text = text.replace(p, "").strip()

                # ---- 第二层：清理模型常见乱码 ----
                # 重复汉字（"课课课课课" → "课课课"）
                text = _re.sub(r'(.)\1{3,}', r'\1\1\1', text)
                # 孤立 1-2 个英文字母（乱码碎片）
                text = _re.sub(r'\s+[a-zA-Z]{1,2}\s+', ' ', text)
                # 连续异常标点
                text = _re.sub(r'[，。！？、；：]{2,}', lambda m: m.group()[0], text)
                # 中文句号后接逗号（乱码）
                text = _re.sub(r'。，', '。', text)
                # 去掉句首残留的 prompt 关键词碎片（如「课堂录音，简体中文，」）
                text = _re.sub(r'^(?:(?:课堂录音|简体中文|专业术语|技术名词|普通话)[，,、\s]*)+', '', text)
                # 开头结尾标点
                text = text.strip('，。！？、；：,.!? ')

                # ---- 第三层：合并空白 ----
                text = _re.sub(r'\s+', ' ', text)
                return text.strip()

            cleaned_text = _clean_chinese(result.get("text", ""))
            # 繁体 → 简体（zhconv 可用时）
            if ZHCONV_AVAILABLE:
                cleaned_text = zhconv.convert(cleaned_text, "zh-cn")

            # 5. 清理临时文件
            try: os.remove(tmp_path)
            except: pass

            segments = [
                {"start": s.get("start", 0), "end": s.get("end", 0),
                 "text": _clean_chinese(s.get("text", ""))}
                for s in result.get("segments", [])
            ]
            print(f"[transcribe] 完成 ({model_size}): {cleaned_text[:60]}...")
            self._respond(200, {
                "ok": True,
                "source": "whisper",
                "text": cleaned_text,
                "segments": segments,
                "model": model_size,
                "filename": filename,
            })
        except subprocess.TimeoutExpired:
            self._respond(504, {"ok": False, "error": "转写超时"})
        except Exception as e:
            print(f"[transcribe] FAIL: {e}")
            self._respond(502, {"ok": False, "error": str(e)[:300]})

    # ============ ⑤ 本地大模型 AI 提炼 ============
    def _handle_summarize(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
            text = (payload.get("text") or "").strip()
            if len(text) < 10:
                self._respond(400, {"ok": False, "error": "文本过短，无需提炼"})
                return
            result = _llm_summarize(text)
            self._respond(200, {"ok": True, **result})
        except Exception as e:
            print(f"[summarize] FAIL: {e}")
            self._respond(503, {"ok": False, "error": str(e)[:200]})

    # ============ ⑥ 视频链接全自动转写 ============
    def _handle_video_transcribe(self):
        """
        接收 JSON { url }
        yt-dlp 下载音轨 → ffmpeg 转码 → Whisper 转写 → 返回 { ok, text, model, title }
        """
        if not YTDLP:
            self._respond(501, {"ok": False, "error": "yt-dlp 未安装。执行: pip install yt-dlp"})
            return
        if not WHISPER_AVAILABLE or not FFMPEG:
            self._respond(501, {"ok": False, "error": "Whisper 或 ffmpeg 未就绪，无法自动转写"})
            return

        tmpdir = None
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
            url = (payload.get("url") or "").strip()
            if not url.startswith(("http://", "https://")):
                self._respond(400, {"ok": False, "error": "缺少合法的视频链接"})
                return

            print(f"[video-transcribe] 开始处理: {url[:90]}")
            tmpdir = tempfile.mkdtemp(prefix="syzz_video_")
            outtmpl = os.path.join(tmpdir, "audio.%(ext)s")

            # 1. 先取标题（失败不影响后续转写）
            title = ""
            try:
                meta = subprocess.run(
                    [YTDLP, "-j", "--skip-download", "--no-playlist", "--no-warnings", url],
                    capture_output=True, timeout=60,
                )
                if meta.returncode == 0:
                    info = json.loads(meta.stdout.decode("utf-8", errors="ignore").strip().splitlines()[0])
                    title = info.get("title", "")
            except Exception as e:
                print(f"[video-transcribe] 取标题失败（忽略）: {e}")

            # 2. 下载并抽取音轨为 mp3
            dl = subprocess.run(
                [YTDLP, "-f", "bestaudio/best", "--no-playlist", "--no-warnings",
                 "-x", "--audio-format", "mp3", "--audio-quality", "5",
                 "-o", outtmpl, url],
                capture_output=True, timeout=900,
            )
            if dl.returncode != 0:
                err_text = dl.stderr.decode(errors="ignore")
                print(f"[video-transcribe] yt-dlp 失败: {err_text[-300:]}")
                self._respond(415, {"ok": False, "error": _humanize_ytdlp_error(err_text)})
                return

            files = [p for p in glob.glob(os.path.join(tmpdir, "audio.*"))
                     if not p.endswith((".part", ".ytdl"))]
            if not files:
                self._respond(415, {"ok": False, "error": "音轨下载失败，请粘贴字幕文稿完成解析"})
                return
            audio_path = files[0]
            print(f"[video-transcribe] 音轨已下载: {os.path.basename(audio_path)} "
                  f"({os.path.getsize(audio_path)} bytes)")

            # 3. 转写
            result = _audio_file_to_text(audio_path)
            text = result["text"]
            if not text or len(text) < 5:
                self._respond(415, {"ok": False, "error": "音轨转写内容为空（可能是纯音乐/无人声），请粘贴字幕文稿"})
                return

            print(f"[video-transcribe] 完成: {text[:50]}...")
            self._respond(200, {"ok": True, "source": "video-audio",
                                "text": text, "model": result["model"], "title": title})
        except subprocess.TimeoutExpired:
            self._respond(504, {"ok": False, "error": "音轨下载或转写超时，请粘贴字幕文稿完成解析"})
        except Exception as e:
            print(f"[video-transcribe] FAIL: {e}")
            self._respond(502, {"ok": False, "error": f"自动转写失败：{str(e)[:150]}，请粘贴字幕文稿完成解析"})
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

    # ============ 响应工具 ============
    def _respond(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # 关闭默认冗长日志


if __name__ == "__main__":
    print("=" * 56)
    print("  疏影拾知 · 视频解析本地代理已启动")
    print(f"  健康检查  : http://127.0.0.1:{PORT}/health")
    print(f"  HTTP 转发 : /fetch?url=<目标地址>")
    print(f"  yt-dlp    : /yt-dlp?url=<目标地址>  [yt-dlp={'可用' if YTDLP else '未安装'}]")
    print(f"  第三方聚合: POST /backend-parse")
    print(f"  AI 提炼   : POST /summarize  [ollama 本地大模型，Qwen 优先/DeepSeek 回退]")
    print(f"  视频全自动: POST /video-transcribe  [yt-dlp 下载音轨 → Whisper 转写]")
    print("  请保持本窗口运行，然后回到页面粘贴视频链接解析")
    print("=" * 56)
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), ProxyHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n[已停止] 代理服务已关闭")
