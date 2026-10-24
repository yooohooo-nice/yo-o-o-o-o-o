import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { AccessStatus } from "@contracts/types";

type AccessGateProps = {
  onAuthenticated: () => void;
};

export function AccessGate({ onAuthenticated }: AccessGateProps) {
  const [password, setPassword] = useState("");
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) {
      setError("请输入访问密码。");
      return;
    }
    if (!adultConfirmed) {
      setError("请先确认你已年满 18 岁。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await apiFetch<AccessStatus>("/api/access/login", {
        method: "POST",
        body: JSON.stringify({ password, adultConfirmed }),
      });
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="access-shell">
      <section className="access-intro" aria-labelledby="access-title">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">流</span>
          <span>流光播放器</span>
        </div>
        <div className="access-statement">
          <p className="utility-label">PRIVATE STREAM · WEB</p>
          <h1 id="access-title">私人播放，<br />无需安装。</h1>
          <p>一个链接，一块屏幕。手机与电脑浏览器均可使用。</p>
        </div>
        <p className="access-footnote">PASSWORD PROTECTED · ADULTS ONLY</p>
      </section>

      <section className="access-form-wrap" aria-label="访问验证">
        <form className="access-form glass-surface" onSubmit={handleSubmit}>
          <div className="form-heading">
            <LockKeyhole size={22} strokeWidth={1.5} aria-hidden="true" />
            <div>
              <h2>输入访问密码</h2>
              <p>此页面不开放注册，使用共享密码进入。</p>
            </div>
          </div>

          <label className="field-label" htmlFor="access-password">访问密码</label>
          <div className="password-field">
            <input
              id="access-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              disabled={loading}
              placeholder="请输入密码"
              maxLength={200}
            />
            <button
              type="button"
              className="icon-button password-toggle"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              title={showPassword ? "隐藏密码" : "显示密码"}
            >
              {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
            </button>
          </div>

          <label className="adult-check">
            <input
              type="checkbox"
              checked={adultConfirmed}
              onChange={(event) => setAdultConfirmed(event.target.checked)}
              disabled={loading}
            />
            <span>我已年满 18 岁，并确认仅访问自己有权观看的内容。</span>
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}

          <button className="primary-button access-submit" type="submit" disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}
            {loading ? "正在验证…" : "进入播放器"}
          </button>

          <p className="legal-copy">
            本服务包含成人内容入口，不提供视频下载，也不在服务器保存视频文件。
          </p>
        </form>
      </section>
    </main>
  );
}
