import React from "react";

export default function LanguageSelector({ languages, language, onSelect, onStart }) {
  return (
    <div className="center-card language-card">
      <h1>Choose a language to start</h1>
      <div className="language-grid">
        {languages.map((l) => (
          <button
            key={l.code}
            className={`lang-btn ${language?.code === l.code ? "active" : ""}`}
            onClick={() => onSelect(l)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <button className="start-btn" disabled={!language} onClick={onStart}>
          Start Chat {language ? `(${language.label})` : ""}
        </button>
      </div>
    </div>
  );
}


