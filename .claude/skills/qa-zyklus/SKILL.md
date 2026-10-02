---
name: qa-zyklus
description: Vollständiger Qualitätszyklus der RevierApp: QA-Agent prüft die App und schreibt einen Bericht, Bugfix-Agent behebt die gefundenen Fehler, QA-Agent prüft die Korrekturen nach. Aufruf mit /qa-zyklus, optional mit Schwerpunkt (z. B. "/qa-zyklus Karte und Druckansicht").
---
Führe den Qualitätszyklus in dieser Reihenfolge aus. Zwischen den Schritten die Ergebnisse weitergeben, nicht raten.

1. **Prüfen**: Starte den Agenten `qa-tester` (Agent-Tool, subagent_type `qa-tester`). Gib ihm den Schwerpunkt aus
   den Argumenten mit, sonst „alle Funktionen“. Warte auf den Bericht `docs/qa/bericht-<Datum>.md`.
2. **Sichten**: Lies den Bericht. Enthält er keine Fehler, melde das dem Nutzer und beende den Zyklus.
3. **Beheben**: Starte den Agenten `bugfixer` mit dem Pfad des Berichts und der Anweisung, alle Fehler mit Schwere
   hoch und mittel zu beheben; niedrige nur, wenn sie klein sind. Warte auf seinen Abschlussbericht.
4. **Nachprüfen**: Starte `qa-tester` erneut mit dem Auftrag, nur die im Bericht als „behoben“ markierten Fehler
   nachzuprüfen und das Ergebnis in denselben Bericht unter „## Nachprüfung“ zu schreiben.
5. **Abschluss**: Führe `npm test` aus. Fasse dem Nutzer zusammen: gefundene, behobene, offene Fehler mit Grund,
   und frage, ob die Commits auf den Branch gepusht werden sollen (Push nur auf ausdrücklichen Wunsch).

Regeln: Die Agenten laufen nacheinander, nicht parallel, weil sie denselben Code und dieselben Ports nutzen.
Kein Agent pusht selbst. Bei einem Fehler, dessen Behebung einen Umbau braucht, wird nur der Vorschlag aus dem
Bericht an den Nutzer weitergegeben.
