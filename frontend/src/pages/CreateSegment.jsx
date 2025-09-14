import React, { useState } from "react";
import axios from "axios";

function ConditionRow({ idx, cond, onChange, onRemove }) {
  return (
    <div>
      <select
        value={cond.field}
        onChange={(e) => onChange(idx, { ...cond, field: e.target.value })}
      >
        <option value="total_spent">total_spent</option>
        <option value="last_order_date">last_order_date</option>
        <option value="email">email</option>
      </select>

      <select
        value={cond.op}
        onChange={(e) => onChange(idx, { ...cond, op: e.target.value })}
      >
        <option value="gt">gt</option>
        <option value="gte">gte</option>
        <option value="lt">lt</option>
        <option value="lte">lte</option>
        <option value="eq">eq</option>
        <option value="neq">neq</option>
      </select>

      <input
        value={cond.value}
        onChange={(e) => onChange(idx, { ...cond, value: e.target.value })}
        placeholder="value"
      />
      <button onClick={() => onRemove(idx)}>Remove</button>
    </div>
  );
}

export default function CreateSegment() {
  const [conditions, setConditions] = useState([
    { field: "total_spent", op: "gt", value: "" },
  ]);
  const [logic, setLogic] = useState("AND");
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const addCondition = () =>
    setConditions([...conditions, { field: "total_spent", op: "gt", value: "" }]);

  const updateCondition = (i, newCond) => {
    const arr = [...conditions];
    arr[i] = newCond;
    setConditions(arr);
  };

  const removeCondition = (i) =>
    setConditions(conditions.filter((_, idx) => idx !== i));

  const handlePreview = async () => {
    setLoading(true);
    setPreview(null);
    try {
      const res = await axios.post("/api/segments/preview", { conditions, logic });
      setPreview(res.data);
    } catch (e) {
      setPreview({ error: "Failed to reach backend" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>Create Segment</h2>
      <div>
        <label>
          Logic:
          <select value={logic} onChange={(e) => setLogic(e.target.value)}>
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
        </label>

        {conditions.map((c, i) => (
          <ConditionRow
            key={i}
            idx={i}
            cond={c}
            onChange={updateCondition}
            onRemove={removeCondition}
          />
        ))}

        <button onClick={addCondition}>Add condition</button>
        <button onClick={handlePreview} disabled={loading}>
          {loading ? "Loading..." : "Preview Audience"}
        </button>

        {preview && preview.error && <div>{preview.error}</div>}
        {preview && !preview.error && (
          <div>
            <strong>Audience count:</strong> {preview.audience_count}
            <pre>{JSON.stringify(preview.sample, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
