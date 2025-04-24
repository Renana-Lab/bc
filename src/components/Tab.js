


const Tab = ({ children, isActive, onClick }) => {
  return (
    <div
      className={`tab ${isActive ? "active" : ""}`}
      onClick={onClick}
      style={{
        padding: "10px",
        cursor: "pointer",
        borderBottom: isActive ? "2px solid #007bff" : "none",
        color: isActive ? "#007bff" : "#000",
      }}
    >
      {children}
    </div>
  );
}