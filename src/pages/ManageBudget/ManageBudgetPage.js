import { Button, TextField, Typography } from "@mui/material";
import { useState, useEffect } from "react";
import Layout from "../../components/Layout";
import Box from "@mui/material/Box";
import toast from "react-hot-toast";

// Initialize globalBudgetStore from localStorage
const globalBudgetStore = JSON.parse(localStorage.getItem("globalBudgetStore")) || {
  defaultBudget: 2000, // Default budget for all users (in wei)
};

// Function to get the default budget
export const getDefaultBudget = () => globalBudgetStore.defaultBudget;

const ManageBudgetPage = () => {
  const [budget, setBudget] = useState(globalBudgetStore.defaultBudget);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const secKey = "1234"; // Example secret key (replace with a secure method in production)

  const handlePass = (event) => {
    const newPass = event.target.value;
    setPass(newPass);
    handleAuth(newPass);
  };

  const handleAuth = (passValue) => {
    if (passValue === secKey) {
      setIsAdmin(true);
      setError("");
    } else {
      setIsAdmin(false);
      setError("Incorrect admin key");
    }
  };

  const handleBudgetChange = (event) => {
    const value = Number(event.target.value);
    if (value >= 0) {
      setBudget(value);
      setError("");
    } else {
      setError("Budget must be a non-negative number");
    }
  };

  const handleSetBudget = () => {
    if (budget >= 0) {
      globalBudgetStore.defaultBudget = budget;
      // Save to localStorage
      localStorage.setItem("globalBudgetStore", JSON.stringify(globalBudgetStore));
      setError("");
      toast.success(
        budget === 0
          ? "Budget set to unlimited spending for all users"
          : `Budget set to ${budget} wei for all users`
      );
    } else {
      setError("Please enter a valid budget");
    }
  };

  const handleResetBudget = () => {
    setBudget(2000);
    globalBudgetStore.defaultBudget = 2000;
    // Save to localStorage
    localStorage.setItem("globalBudgetStore", JSON.stringify(globalBudgetStore));
    setError("");
    toast.success("Budget reset to 2000 wei for all users");
  };

  useEffect(() => {
    const handleKeyPress = (event) => {
      if (event.code === "Space") {
        handleAuth(pass);
      }
    };
    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [pass]);

  return (
    <Layout>
      <Box
        className="manage-budget-page"
        display="flex"
        justifyContent="center"
        flexDirection="column"
        sx={{
          margin: "200px auto 0 auto",
          background: "white",
          padding: "2rem",
          borderRadius: "20px",
          width: "40rem",
          boxShadow: "0px 0px 25px rgba(0, 0, 0, 0.2)",
        }}
      >
        {isAdmin ? (
          <>
            <Typography variant="h3" textAlign="center">
              Set Budget
            </Typography>
            <TextField
              onChange={handleBudgetChange}
              type="number"
              label="Budget (in wei)"
              variant="outlined"
              value={budget}
              sx={{ marginTop: "1rem" }}
            />
            <Typography
              variant="caption"
              textAlign="center"
              sx={{ marginTop: "0.5rem", display: "block" }}
            >
              Set to 0 for unlimited spending
            </Typography>
            {error && (
              <Typography color="error" textAlign="center" sx={{ marginTop: "0.5rem" }}>
                {error}
              </Typography>
            )}
            <Box
              display="flex"
              justifyContent="center"
              gap="1rem"
              sx={{ marginTop: "1rem" }}
            >
              <Button variant="contained" onClick={handleSetBudget}>
                Set
              </Button>
              <Button variant="outlined" onClick={handleResetBudget}>
                Reset
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Typography variant="h5" textAlign="center">
             Admin Zone
            </Typography>
            <br />
            <Typography variant="h6" textAlign="center">
              Enter Key to Unlock
            </Typography>
            <TextField
              onChange={handlePass}
              label="Admin Key"
              variant="outlined"
              value={pass}
              sx={{ marginTop: "1rem" }}
            />
            {error && (
              <Typography color="error" textAlign="center" sx={{ marginTop: "0.5rem" }}>
                {error}
              </Typography>
            )}
            <Typography variant="caption" textAlign="center" sx={{ marginTop: "0.5rem" }}>
              Press the "Space" key to unlock the admin panel
            </Typography>
          </>
        )}
      </Box>
    </Layout>
  );
};

export default ManageBudgetPage;