# 🔍 Code Review Report

## Summary

| Metric | Value |
|--------|-------|
| **Overall Score** | 0/100 |
| **Files Reviewed** | 1 |
| **Critical Issues** | 3 |
| **High Priority Tests** | 7 |
| **Refactoring Opportunities** | 5 |

## 🎯 Top Recommendations

1. 🚨 **Security**: Fix SQL injection in searchTodos() at line 121. The keyword parameter is directly interpolated into the SQL query using template literals, allowing attackers to execute arbitrary SQL commands. Replace with parameterized query: use 'SELECT * FROM todos WHERE title LIKE $1 OR description LIKE $2' with [searchPattern, searchPattern] as parameters.
   - Files: src/todo.ts

2. 🚨 **Security**: Fix SQL injection in searchTodosByStatus() at line 132. The completed parameter is concatenated directly into SQL without validation. Change the parameter type from string to boolean and use parameterized query: 'SELECT * FROM todos WHERE completed = $1' with [completed] as parameter.
   - Files: src/todo.ts

3. 🚨 **Security**: Fix SQL injection and authorization bypass in getTodosByUser() at line 143. The userId is embedded in the JOIN query using template literals, allowing attackers to view all users' todos or extract sensitive data. Use parameterized query: 'SELECT t.* FROM todos t JOIN user_todos ut ON t.id = ut.todo_id WHERE ut.user_id = $1' with [userId] as parameter.
   - Files: src/todo.ts

4. 🚨 **Testing**: Add comprehensive test coverage for the three new search functions (searchTodos, searchTodosByStatus, getTodosByUser) at lines 119-146. These functions have zero test coverage despite containing critical SQL injection vulnerabilities. Tests must verify parameterized query usage, SQL injection prevention, proper error handling, and expected results for valid inputs.
   - Files: src/todo.ts

5. ⚠️ **Security**: Implement runtime validation for database query results at lines 82, 96, 123, 134, and 145. Type assertions (as Todo[] or as Todo) create type safety holes where malformed database data bypasses validation. Use a schema validator like Zod to validate external data at boundaries before casting to TypeScript types.
   - Files: src/todo.ts

## 📁 File Details

### 📄 `src/todo.ts`

**Quality Score:** 0/100 | **Coverage:** ~39%

#### Issues (13)
  - Line 121: `critical` SQL injection vulnerability (OWASP A03:2021 - Injection). The keyword parameter is directly interpolated into the SQL query using template literals without parameterization. An attacker can inject arbitrary SQL: keyword = "' OR '1'='1" would return all todos, or "'; DROP TABLE todos; --" could delete the entire table.
  - Line 132: `critical` SQL injection vulnerability (OWASP A03:2021 - Injection). The completed parameter is concatenated directly into the SQL query without any validation or parameterization. An attacker can pass completed = "1 OR 1=1" to bypass the WHERE clause or "1; DROP TABLE todos; --" to execute arbitrary SQL.
  - Line 143: `critical` SQL injection vulnerability (OWASP A03:2021 - Injection). The userId parameter is embedded in the SQL query using template literals without parameterization. An attacker can inject SQL through userId: userId = "' OR '1'='1" would return all todos across all users, bypassing user isolation.

  *...and 10 more*

#### Test Gaps (10)
  - `searchTodos() lines 119-124` (critical priority)
  - `searchTodosByStatus() lines 130-135` (critical priority)

  *...and 8 more*

#### Refactoring Opportunities (5)
  - **pattern-improvement**: Replace SQL string concatenation with parameterized query to prevent SQL injection. The keyword is directly interpolated into the SQL query without sanitization, allowing arbitrary SQL execution.
  - **pattern-improvement**: Replace string concatenation with parameterized query and add type validation. The completed parameter is a string that gets concatenated directly into SQL, and should be validated as a boolean value before use.

  *...and 3 more*

---

*Generated at 2026-11-12T06:42:01.755Z • Duration: 291290ms*
