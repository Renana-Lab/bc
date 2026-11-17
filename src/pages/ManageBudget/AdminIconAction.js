import { IconButton, Tooltip } from "@mui/material";

// Same wrapper as the marketplace admin IconAction: tooltip + aria-label on a (possibly disabled) icon button.
const AdminIconAction = ({ title, children, ...props }) => (
  <Tooltip title={title}>
    <span>
      <IconButton aria-label={title} size="small" {...props}>
        {children}
      </IconButton>
    </span>
  </Tooltip>
);

export default AdminIconAction;
