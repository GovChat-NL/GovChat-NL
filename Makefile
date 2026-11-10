# Convenience wrapper around the docker compose stack.
# Run `make help` for the list of targets.

COMPOSE := docker compose --profile admin-overlay

.PHONY: help env up down logs reload-workflows rebuild rebuild-admin check test-beleidskompas test-beleidskompas-db generate-workflows

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /: /' | sort

env: ## Create .env from .env.example if it doesn't exist yet
	@test -f .env || (cp .env.example .env && echo "Created .env - fill in the required secrets (see README.md)")

up: env ## Start the full stack, including the overlay admin
	$(COMPOSE) up -d

down: ## Stop and remove all containers and the network (keeps the data volumes and /opt/librechat)
	$(COMPOSE) down

logs: ## Tail the logs of all services, or of one: make logs service=n8n
	$(COMPOSE) logs -f $(service)

reload-workflows: ## Re-import and publish the workflows from agents/n8n/workflows, then restart n8n
	AGENTS_BOOTSTRAP_FORCE=true $(COMPOSE) up -d --force-recreate n8n-bootstrap
	$(COMPOSE) wait n8n-bootstrap
	$(COMPOSE) restart n8n

rebuild: generate-workflows ## Regenerate the workflows, rebuild the images and restart the whole stack, including the overlay admin, with the workflows re-imported (keeps the data)
	$(COMPOSE) down
	AGENTS_BOOTSTRAP_FORCE=true $(COMPOSE) up -d --build
	$(COMPOSE) wait n8n-bootstrap
	$(COMPOSE) restart n8n
	$(COMPOSE) ps

rebuild-admin: ## Rebuild and restart the overlay admin
	$(COMPOSE) up -d --build govchat-overlay-admin

check: ## Validate the compose file, the workflow exports and the scripts (no running stack needed)
	$(COMPOSE) --env-file .env.example config --quiet
	node tests/agents/validate-workflows.js
	node --check n8n/bootstrap.js
	node --check services/admin-overlay/admin/server.js

test-beleidskompas: ## Run the Beleidskompas unit tests: the workflows, the page and the store (no Docker needed)
	cd agents/beleidskompas && node --test
	cd overlay/src/apps/beleidskompas && node --test
	cd services/admin-overlay/admin && node --test

test-beleidskompas-db: ## Run the Beleidskompas store against the real database, inside the admin container (the stack must be running)
	$(COMPOSE) run --rm --no-deps -e BELEIDSKOMPAS_DB_TEST=true -v ./services/admin-overlay/admin/tests:/app/tests:ro govchat-overlay-admin node --test tests/beleidskompas-db.test.js

generate-workflows: ## Regenerate the Beleidskompas workflows (orchestrator and the steps) from agents/beleidskompas
	cd agents/beleidskompas && node generate-workflow.js
