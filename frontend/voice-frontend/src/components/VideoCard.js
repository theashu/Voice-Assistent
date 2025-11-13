import React from "react";

export default function VideoCard({
  isRecording,
  onToggleRecord,
  onOpenTranscript,
  onEndChat,
  children,
}) {
  return (
    <div className="center-card chat-card">
      <div className="video-card">
        <div className="timer-badge">&nbsp;</div>
        <div className="video-placeholder">
          <div className="fake-content">
            <img src="/mascot.svg" alt="Mascot" className="mascot" />
          </div>
        </div>
        <div className="ui-overlay">
          <div className="left-controls">
            <button
              className={`icon-btn ${isRecording ? "recording" : ""}`}
              onClick={onToggleRecord}
              title="Record (mic)"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path
                  fill="currentColor"
                  d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
                />
                <path
                  fill="currentColor"
                  d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 0 0 2 0v-3.08A7 7 0 0 0 19 11z"
                />
              </svg>
            </button>
            <button
              className="icon-btn"
              onClick={onOpenTranscript}
              title="Transcript / History"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path
                  fill="currentColor"
                  d="M4 5h16v2H4zM4 11h16v2H4zM4 17h16v2H4z"
                />
              </svg>
            </button>
          </div>
          <div className="center-control">{children}</div>
          <div className="right-controls">
            <button className="end-btn" onClick={onEndChat}>
              End Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
