// Nexus endpoints (OperatorService), cluster-scoped. Temporal 1.24 does not
// implement them: the server answers 501, which the pages show as "not
// available on this server".
import { seg } from '../api';
import type { Payload } from '../payload/decode';
import { cliCommand } from './cli-command';
import { textPayload } from './encode';
import type { ActionRequest } from './workflow-actions';

export interface EndpointSpec {
  name: string;
  description?: Payload;
  target?: { worker?: { namespace?: string; taskQueue?: string }; external?: { url?: string } };
}

export interface Endpoint {
  id: string;
  version: string;
  spec?: EndpointSpec;
  urlPrefix?: string;
  createdTime?: string;
  lastModifiedTime?: string;
}

export interface EndpointForm {
  name: string;
  description: string;
  targetNamespace: string;
  targetTaskQueue: string;
}

export function endpointSpec(f: EndpointForm): EndpointSpec {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(f.name.trim())) throw new Error('The name must start with a letter or underscore and use letters, digits, - and _.');
  if (!f.targetNamespace.trim() || !f.targetTaskQueue.trim()) throw new Error('A target namespace and task queue are required.');
  return {
    name: f.name.trim(),
    ...(f.description.trim() ? { description: textPayload(f.description.trim()) } : {}),
    target: { worker: { namespace: f.targetNamespace.trim(), taskQueue: f.targetTaskQueue.trim() } },
  };
}

export function createEndpointRequest(spec: EndpointSpec): ActionRequest {
  return {
    method: 'POST',
    path: '/api/v1/nexus/endpoints',
    body: { spec },
    cli: cliCommand(['operator', 'nexus', 'endpoint', 'create'], [['name', spec.name], ['target-namespace', spec.target?.worker?.namespace], ['target-task-queue', spec.target?.worker?.taskQueue]]),
  };
}

export function updateEndpointRequest(id: string, version: string, spec: EndpointSpec): ActionRequest {
  return {
    method: 'POST',
    path: `/api/v1/nexus/endpoints/${seg(id)}/update`,
    body: { version, spec },
    cli: cliCommand(['operator', 'nexus', 'endpoint', 'update'], [['name', spec.name], ['target-namespace', spec.target?.worker?.namespace], ['target-task-queue', spec.target?.worker?.taskQueue]]),
  };
}

export function deleteEndpointRequest(id: string, version: string, name: string): ActionRequest {
  return {
    method: 'DELETE',
    path: `/api/v1/nexus/endpoints/${seg(id)}`,
    query: { version },
    cli: cliCommand(['operator', 'nexus', 'endpoint', 'delete'], [['name', name]]),
  };
}
