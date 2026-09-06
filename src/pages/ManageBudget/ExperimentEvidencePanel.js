import { useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import toast from "react-hot-toast";
import {
  clearExperimentEvidence,
  getExperimentEvidence,
  parseExperimentEvents,
  saveExperimentEvents,
  saveExperimentManifest,
} from "../../experiment/experimentEvidence";

const readFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ""));
  reader.onerror = () => reject(reader.error || new Error("File read failed"));
  reader.readAsText(file);
});

const ExperimentEvidencePanel = () => {
  const [evidence, setEvidence] = useState(getExperimentEvidence);
  const importManifest = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const manifest = saveExperimentManifest(JSON.parse(await readFile(file)));
      setEvidence((current) => ({ ...current, manifest }));
      toast.success(`Loaded ${manifest.experimentId}`);
    } catch (error) {
      toast.error(error.message);
    }
  };
  const importEvents = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const events = saveExperimentEvents(parseExperimentEvents(await readFile(file)));
      setEvidence((current) => ({ ...current, events }));
      toast.success(`Loaded ${events.length} evidence events`);
    } catch (error) {
      toast.error(error.message);
    }
  };
  const clear = () => {
    clearExperimentEvidence();
    setEvidence({ manifest: null, events: [] });
    toast.success("Experiment evidence removed from this browser");
  };

  return (
    <Box sx={{ display: "grid", gap: 1.5 }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" }, gap: 1 }}>
        <Box sx={{ p: 1.25, border: "1px solid #dfe4f4", borderRadius: 1.5 }}>
          <Typography variant="caption" color="text.secondary">Current experiment</Typography>
          <Typography sx={{ fontWeight: 700 }}>{evidence.manifest?.experimentId || "None loaded"}</Typography>
        </Box>
        <Box sx={{ p: 1.25, border: "1px solid #dfe4f4", borderRadius: 1.5 }}>
          <Typography variant="caption" color="text.secondary">Public roles</Typography>
          <Typography sx={{ fontWeight: 700 }}>{evidence.manifest?.participants?.length || 0}</Typography>
        </Box>
        <Box sx={{ p: 1.25, border: "1px solid #dfe4f4", borderRadius: 1.5 }}>
          <Typography variant="caption" color="text.secondary">Runtime events</Typography>
          <Typography sx={{ fontWeight: 700 }}>{evidence.events.length}</Typography>
        </Box>
      </Box>
      <Typography variant="body2" color="text.secondary">
        Import the public manifest and the runner JSONL after the session. Reports will join experiment roles, archetypes, list states, decisions, transactions, and failures without importing private keys.
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        <Button component="label" variant="outlined">
          Import public manifest
          <input hidden type="file" accept=".json,application/json" onChange={importManifest} />
        </Button>
        <Button component="label" variant="outlined">
          Import evidence log
          <input hidden type="file" accept=".jsonl,.txt,application/json" onChange={importEvents} />
        </Button>
        <Button color="error" onClick={clear} disabled={!evidence.manifest && !evidence.events.length}>Clear evidence</Button>
      </Box>
    </Box>
  );
};

export default ExperimentEvidencePanel;
