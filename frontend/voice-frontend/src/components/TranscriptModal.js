import React from "react";

export default function TranscriptModal({ open, messages, onClose }) {
  if (!open) return null;
  return (
    <div className="modal">
      <div className="modal-content">
        <h3>Transcript</h3>
        <div className="transcript-list">
          {messages.length === 0 && <div className="empty">No messages yet</div>}
          {messages.map((m, idx) => (
            <div key={idx} className={`transcript-item ${m.role}`}>
              <div className="role">{m.role}</div>
              <div className="text">{m.text}</div>
              <div className="ts">{m.ts ? new Date(m.ts).toLocaleTimeString() : ""}</div>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "right", marginTop: 12 }}>
          <button onClick={onClose} className="ok-btn">Close</button>
        </div>
      </div>
    </div>
  );
}


