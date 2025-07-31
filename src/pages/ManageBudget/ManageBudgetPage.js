import { Button, TextField, Typography, Box } from "@mui/material";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import toast from "react-hot-toast";

const LOCAL_STORAGE_KEY = "globalBudgetStore";
const DEFAULT_BUDGET = 2000; // in wei
// const ADMIN_SECRET = process.env.REACT_APP_ADMIN_SECRET;
const ADMIN = 1234;

const getStoredBudget = () => {
  const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
  return stored ? JSON.parse(stored).defaultBudget : DEFAULT_BUDGET;
};

const saveBudget = (budget) => {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ defaultBudget: budget }));
};



export const getDefaultBudget = () => getStoredBudget();

const ManageBudgetPage = () => {
  const navigate = useNavigate();
  const [budget, setBudget] = useState(getStoredBudget());
  const [isAdmin, setIsAdmin] = useState(false);
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");

    useEffect(() => {
      if (!window.ethereum) {
        navigate("/"); // Redirect away if no MetaMask
        return;
      }
    });

  const authenticate = () => {
    console.log("password = ", ADMIN);
    if (pass === ADMIN) {
      setIsAdmin(true);
      setError("");
      toast.success("Admin access granted");
    } else {
      setError("Incorrect admin key");
    }
  };

  const handleBudgetChange = (e) => {
    const value = Number(e.target.value);
    if (value >= 0) {
      setBudget(value);
      setError("");
    } else {
      setError("Budget must be a non-negative number");
    }
  };

  const handleSaveBudget = () => {
    if (budget >= 0) {
      saveBudget(budget);
      navigate("/auctions-list");
      toast.success(
        budget === 0
          ? "Unlimited spending enabled for all users"
          : `Budget set to ${budget} wei for all users`
      );
    } else {
      setError("Please enter a valid budget");
    }
  };

  const handleResetBudget = () => {
    saveBudget(DEFAULT_BUDGET);
    setBudget(DEFAULT_BUDGET);
    navigate("/auctions-list");
    toast.success("Budget reset to 2000 wei for all users");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      authenticate();
    }
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pass]);

  return (
    <Layout>
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        sx={{
          marginTop: 16,
          backgroundColor: "background.paper",
          padding: 4,
          borderRadius: 4,
          boxShadow: 3,
          width: "100%",
          maxWidth: 480,
          mx: "auto",
        }}
      >
        {isAdmin ? (
          <>
            <Typography variant="h4" gutterBottom>
              Set Global Budget
            </Typography>
            <TextField
              label="Budget (wei)"
              type="number"
              value={budget}
              onChange={handleBudgetChange}
              fullWidth
              sx={{ mt: 2 }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Set to 0 for unlimited spending
            </Typography>
            {error && (
              <Typography color="error" sx={{ mt: 1 }}>
                {error}
              </Typography>
            )}
            <Box display="flex" gap={2} sx={{ mt: 3 }}>
              <Button variant="contained" color="success" onClick={handleSaveBudget} fullWidth>
                Save
              </Button>
              <Button variant="outlined" color="secondary" onClick={handleResetBudget} fullWidth>
                Reset
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Typography variant="h5" gutterBottom>
              Admin Access Required
            </Typography>
            <TextField
              label="Admin Key"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              fullWidth
              sx={{ mt: 2 }}
            />
            <Button
              variant="contained"
              color="primary"
              fullWidth
              sx={{ mt: 3 }}
              onClick={authenticate}
            >
              Unlock
            </Button>
            {error && (
              <Typography color="error" sx={{ mt: 2 }}>
                {error}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2 }}>
              Press Enter after typing your key
            </Typography>
          </>
        )}
      </Box>
    </Layout>
  );
};

export default ManageBudgetPage;
